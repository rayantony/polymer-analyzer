/**
 * @license
 * Copyright (c) 2016 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at
 * http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at
 * http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at
 * http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at
 * http://polymer.github.io/PATENTS.txt
 */

import * as path from 'path';

import {ForkOptions, LazyEdgeMap, NoKnownParserError, Options, ScannerTable} from '../analyzer';
import {CssParser} from '../css/css-parser';
import {HtmlCustomElementReferenceScanner} from '../html/html-element-reference-scanner';
import {HtmlImportScanner} from '../html/html-import-scanner';
import {HtmlParser} from '../html/html-parser';
import {HtmlScriptScanner} from '../html/html-script-scanner';
import {HtmlStyleScanner} from '../html/html-style-scanner';
import {Severity} from '../index';
import {ClassScanner} from '../javascript/class-scanner';
import {FunctionScanner} from '../javascript/function-scanner';
import {JavaScriptParser} from '../javascript/javascript-parser';
import {NamespaceScanner} from '../javascript/namespace-scanner';
import {JsonParser} from '../json/json-parser';
import {Document, InlineDocInfo, LocationOffset, ScannedDocument, ScannedElement, ScannedFeature, ScannedImport, ScannedInlineDocument, Warning, WarningCarryingException} from '../model/model';
import {ParsedDocument} from '../parser/document';
import {Parser} from '../parser/parser';
import {BehaviorScanner} from '../polymer/behavior-scanner';
import {CssImportScanner} from '../polymer/css-import-scanner';
import {DomModuleScanner} from '../polymer/dom-module-scanner';
import {PolymerElementScanner} from '../polymer/polymer-element-scanner';
import {PseudoElementScanner} from '../polymer/pseudo-element-scanner';
import {scan} from '../scanning/scan';
import {Scanner} from '../scanning/scanner';
import {TypeScriptPreparser} from '../typescript/typescript-preparser';
import {PackageUrlResolver} from '../url-loader/package-url-resolver';
import {UrlLoader} from '../url-loader/url-loader';
import {UrlResolver} from '../url-loader/url-resolver';

import {AnalysisCache} from './analysis-cache';
import {LanguageAnalyzer} from './language-analyzer';

/**
 * An analysis of a set of files at a specific point-in-time with respect to
 * updates to those files. New files can be added to an existing context, but
 * updates to files will cause a fork of the context with new analysis results.
 *
 * All file contents and analysis results are consistent within a single
 * anaysis context. A context is forked via either the fileChanged or
 * clearCaches methods.
 *
 * For almost all purposes this is an entirely internal implementation detail.
 * An Analyzer instance has a reference to its current context, so it will
 * appear to be statefull with respect to file updates.
 */
export class AnalysisContext {
  readonly parsers = new Map<string, Parser<ParsedDocument<any, any>>>([
    ['html', new HtmlParser()],
    ['js', new JavaScriptParser()],
    ['ts', new TypeScriptPreparser()],
    ['css', new CssParser()],
    ['json', new JsonParser()],
  ]);

  private readonly _languageAnalyzers = new Map<string, LanguageAnalyzer<any>>([
    // TODO(rictic): add typescript language analyzer back after investigating
    //     https://github.com/Polymer/polymer-analyzer/issues/623
  ]);

  /** A map from import url to urls that document lazily depends on. */
  private readonly _lazyEdges: LazyEdgeMap|undefined;

  private readonly _scanners: ScannerTable;

  readonly loader: UrlLoader;
  readonly resolver: UrlResolver;

  private readonly _cache: AnalysisCache;

  /** Incremented each time we fork. Useful for debugging. */
  private readonly _generation: number;

  /**
   * Resolves when the previous analysis has completed.
   *
   * Used to serialize analysis requests, not for correctness surprisingly
   * enough, but for performance, so that we can reuse AnalysisResults.
   */
  private _analysisComplete: Promise<void>;

  private static _getDefaultScanners(lazyEdges: LazyEdgeMap|undefined) {
    return new Map<string, Scanner<any, any, any>[]>([
      [
        'html',
        [
          new HtmlImportScanner(lazyEdges),
          new HtmlScriptScanner(),
          new HtmlStyleScanner(),
          new DomModuleScanner(),
          new CssImportScanner(),
          new HtmlCustomElementReferenceScanner(),
          new PseudoElementScanner(),
        ]
      ],
      [
        'js',
        [
          new PolymerElementScanner(),
          new BehaviorScanner(),
          new NamespaceScanner(),
          new FunctionScanner(),
          new ClassScanner()
        ]
      ],
    ]);
  }

  constructor(options: Options, cache?: AnalysisCache, generation?: number) {
    this.loader = options.urlLoader;
    this.resolver = options.urlResolver || new PackageUrlResolver();
    this.parsers = options.parsers || this.parsers;
    this._lazyEdges = options.lazyEdges;
    this._scanners = options.scanners ||
        AnalysisContext._getDefaultScanners(this._lazyEdges);
    this._cache = cache || new AnalysisCache();
    this._generation = generation || 0;
  }

  /**
   * Returns a copy of this cache context with proper cache invalidation.
   */
  filesChanged(urls: string[]) {
    const newCache =
        this._cache.invalidate(urls.map((url) => this.resolveUrl(url)));
    return this._fork(newCache);
  }

  /**
   * Implements Analyzer#analyze, see its docs.
   */
  async analyze(urls: string[]): Promise<AnalysisContext> {
    const resolvedUrls = urls.map((url) => this.resolveUrl(url));

    // 1. Await current analysis if there is one, so we can check to see if has
    // all of the requested URLs.
    await this._analysisComplete;

    // 2. Check to see if we have all of the requested documents
    const hasAllDocuments = resolvedUrls.every(
        (url) => this._cache.analyzedDocuments.get(url) != null);
    if (hasAllDocuments) {
      // all requested URLs are present, return the existing context
      return this;
    }

    // 3. Some URLs are new, so fork, but don't invalidate anything
    const newCache = this._cache.invalidate([]);
    const newContext = this._fork(newCache);
    return newContext._analyze(resolvedUrls);
  }

  /**
   * Internal analysis method called when we know we need to fork.
   */
  private async _analyze(resolvedUrls: string[]): Promise<AnalysisContext> {
    const analysisComplete = (async() => {
      // 1. Load and scan all root documents
      const scannedDocumentsOrWarnings =
          await Promise.all(resolvedUrls.map(async(url) => {
            try {
              const scannedResult = await this.scan(url);
              this._cache.failedDocuments.delete(url);
              return scannedResult;
            } catch (e) {
              if (e instanceof WarningCarryingException) {
                this._cache.failedDocuments.set(url, e.warning);
              }
              // No need for fallback warning, one will be produced in
              // getDocument
            }
          }));
      const scannedDocuments = scannedDocumentsOrWarnings.filter(
          (d) => d != null) as ScannedDocument[];
      // 2. Run per-document resolution
      const documents = scannedDocuments.map((d) => this.getDocument(d.url));
      // TODO(justinfagnani): instead of the above steps, do:
      // 1. Load and run prescanners
      // 2. Run global analyzers (_languageAnalyzers now, but it doesn't need to
      // be
      //    separated by file type)
      // 3. Run per-document scanners and resolvers
      return documents;
    })();
    this._analysisComplete = analysisComplete.then((_) => {});
    await this._analysisComplete;
    return this;
  }

  /**
   * Gets an analyzed Document from the document cache. This is only useful for
   * Analyzer plugins. You almost certainly want to use `analyze()` instead.
   *
   * If a document has been analyzed, it returns the analyzed Document. If not
   * the scanned document cache is used and a new analyzed Document is returned.
   * If a file is in neither cache, it returns `undefined`.
   */
  getDocument(url: string): Document|Warning {
    const resolvedUrl = this.resolveUrl(url);
    const cachedWarning = this._cache.failedDocuments.get(resolvedUrl);
    if (cachedWarning) {
      return cachedWarning;
    }
    const cachedResult = this._cache.analyzedDocuments.get(resolvedUrl);
    if (cachedResult) {
      return cachedResult;
    }
    const scannedDocument = this._cache.scannedDocuments.get(resolvedUrl);
    if (!scannedDocument) {
      return <Warning>{
        sourceRange: {
          file: this.resolveUrl(url),
          start: {line: 0, column: 0},
          end: {line: 0, column: 0}
        },
        code: 'unable-to-analyze',
        message: `Document not found: ${url}`,
        severity: Severity.ERROR
      };
    }

    const extension = path.extname(resolvedUrl).substring(1);
    const languageAnalyzer = this._languageAnalyzers.get(extension);
    let analysisResult: any;
    if (languageAnalyzer) {
      analysisResult = languageAnalyzer.analyze(scannedDocument.url);
    }

    const document = new Document(scannedDocument, this, analysisResult);
    this._cache.analyzedDocuments.set(resolvedUrl, document);
    this._cache.analyzedDocumentPromises.getOrCompute(
        resolvedUrl, async() => document);

    document.resolve();
    return document;
  }

  /**
   * This is only useful for Analyzer plugins.
   *
   * If a url has been scanned, returns the ScannedDocument.
   */
  _getScannedDocument(url: string): ScannedDocument|undefined {
    const resolvedUrl = this.resolveUrl(url);
    return this._cache.scannedDocuments.get(resolvedUrl);
  }

  /**
   * Clear all cached information from this analyzer instance.
   *
   * Note: if at all possible, instead tell the analyzer about the specific
   * files that changed rather than clearing caches like this. Caching provides
   * large performance gains.
   */
  clearCaches(): AnalysisContext {
    return this._fork(new AnalysisCache());
  }

  /**
   * Returns a copy of the context but with optional replacements of cache or
   * constructor options.
   *
   * Note: this feature is experimental.
   */
  _fork(cache?: AnalysisCache, options?: ForkOptions): AnalysisContext {
    const contextOptions: Options = {
      lazyEdges: this._lazyEdges,
      parsers: this.parsers,
      scanners: this._scanners,
      urlLoader: this.loader,
      urlResolver: this.resolver,
    };
    if (options && options.urlLoader) {
      contextOptions.urlLoader = options.urlLoader;
    }
    if (!cache) {
      cache = this._cache.invalidate([]);
    }
    const copy =
        new AnalysisContext(contextOptions, cache, this._generation + 1);
    return copy;
  }

  /**
   * Scans a file locally, that is for features that do not depend
   * on this files imports. Local features can be cached even when
   * imports are invalidated. This method does not trigger transitive
   * scanning, _scan() does that.
   *
   * TODO(justinfagnani): consider renaming this to something like
   * _preScan, since about the only useful things it can find are
   * imports, exports and other syntactic structures.
   */
  private async _scanLocal(resolvedUrl: string): Promise<ScannedDocument> {
    return this._cache.scannedDocumentPromises.getOrCompute(
        resolvedUrl, async() => {
          try {
            const parsedDoc = await this._parse(resolvedUrl);
            const scannedDocument = await this._scanDocument(parsedDoc);

            const imports = scannedDocument.getNestedFeatures().filter(
                (e) => e instanceof ScannedImport) as ScannedImport[];

            // Update dependency graph
            const importUrls = imports.map((i) => this.resolveUrl(i.url));
            this._cache.dependencyGraph.addDocument(resolvedUrl, importUrls);

            return scannedDocument;
          } catch (e) {
            this._cache.dependencyGraph.rejectDocument(resolvedUrl, e);
            throw e;
          }
        });
  }

  /**
   * Scan a toplevel document and all of its transitive dependencies.
   */
  async scan(resolvedUrl: string): Promise<ScannedDocument> {
    return this._cache.dependenciesScannedPromises.getOrCompute(
        resolvedUrl, async() => {
          const scannedDocument = await this._scanLocal(resolvedUrl);
          const imports = scannedDocument.getNestedFeatures().filter(
              (e) => e instanceof ScannedImport) as ScannedImport[];

          // Scan imports
          for (const scannedImport of imports) {
            const importUrl = this.resolveUrl(scannedImport.url);
            // Request a scan of `importUrl` but do not wait for the results to
            // avoid deadlock in the case of cycles. Later we use the
            // DependencyGraph to wait for all transitive dependencies to load.
            this.scan(importUrl).catch((error) => {
              scannedImport.error = error || '';
            });
          }
          await this._cache.dependencyGraph.whenReady(resolvedUrl);
          return scannedDocument;
        });
  }

  /**
   * Scans a ParsedDocument.
   */
  private async _scanDocument(
      document: ParsedDocument<any, any>,
      maybeAttachedComment?: string): Promise<ScannedDocument> {
    const warnings: Warning[] = [];
    const scannedFeatures = await this._getScannedFeatures(document);
    // If there's an HTML comment that applies to this document then we assume
    // that it applies to the first feature.
    const firstScannedFeature = scannedFeatures[0];
    if (firstScannedFeature && firstScannedFeature instanceof ScannedElement) {
      firstScannedFeature.applyHtmlComment(maybeAttachedComment);
    }

    const scannedDocument =
        new ScannedDocument(document, scannedFeatures, warnings);

    if (!scannedDocument.isInline) {
      if (this._cache.scannedDocuments.has(scannedDocument.url)) {
        throw new Error(
            'Scanned document already in cache. This should never happen.');
      }
      this._cache.scannedDocuments.set(scannedDocument.url, scannedDocument);
    }
    await this._scanInlineDocuments(scannedDocument);
    return scannedDocument;
  }

  private async _getScannedFeatures(document: ParsedDocument<any, any>):
      Promise<ScannedFeature[]> {
    const scanners = this._scanners.get(document.type);
    if (scanners) {
      return scan(document, scanners);
    }
    return [];
  }

  private async _scanInlineDocuments(containingDocument: ScannedDocument) {
    for (const feature of containingDocument.features) {
      if (!(feature instanceof ScannedInlineDocument)) {
        continue;
      }
      const locationOffset: LocationOffset = {
        line: feature.locationOffset.line,
        col: feature.locationOffset.col,
        filename: containingDocument.url
      };
      try {
        const parsedDoc = this._parseContents(
            feature.type,
            feature.contents,
            containingDocument.url,
            {locationOffset, astNode: feature.astNode});
        const scannedDoc =
            await this._scanDocument(parsedDoc, feature.attachedComment);

        feature.scannedDocument = scannedDoc;
      } catch (err) {
        if (err instanceof WarningCarryingException) {
          containingDocument.warnings.push(err.warning);
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Returns `true` if the provided resolved URL can be loaded.  Obeys the
   * semantics defined by `UrlLoader` and should only be used to check
   * resolved URLs.
   */
  canLoad(resolvedUrl: string): boolean {
    return this.loader.canLoad(resolvedUrl);
  }

  /**
   * Loads the content at the provided resolved URL.  Obeys the semantics
   * defined by `UrlLoader` and should only be used to attempt to load resolved
   * URLs.
   *
   * Currently does no caching. If the provided contents are given then they
   * are used instead of hitting the UrlLoader (e.g. when you have in-memory
   * contents that should override disk).
   */
  async load(resolvedUrl: string): Promise<string> {
    if (!this.canLoad(resolvedUrl)) {
      throw new Error(`Can't load URL: ${resolvedUrl}`);
    }
    return await this.loader.load(resolvedUrl);
  }

  /**
   * Caching + loading wrapper around _parseContents.
   */
  private async _parse(resolvedUrl: string): Promise<ParsedDocument<any, any>> {
    return this._cache.parsedDocumentPromises.getOrCompute(
        resolvedUrl, async() => {
          const content = await this.load(resolvedUrl);
          const extension = path.extname(resolvedUrl).substring(1);
          return this._parseContents(extension, content, resolvedUrl);
        });
  }

  /**
   * Parse the given string into the Abstract Syntax Tree (AST) corresponding
   * to its type.
   */
  private _parseContents(
      type: string, contents: string, url: string,
      inlineInfo?: InlineDocInfo<any>): ParsedDocument<any, any> {
    const parser = this.parsers.get(type);
    if (parser == null) {
      throw new NoKnownParserError(`No parser for for file type ${type}`);
    }
    try {
      return parser.parse(contents, url, inlineInfo);
    } catch (error) {
      if (error instanceof WarningCarryingException) {
        throw error;
      }
      throw new Error(`Error parsing ${url}:\n ${error.stack}`);
    }
  }

  /**
   * Returns true if the url given is resovable by the Analyzer's `UrlResolver`.
   */
  canResolveUrl(url: string): boolean {
    return this.resolver.canResolve(url);
  }

  /**
   * Resolves a URL with this Analyzer's `UrlResolver` or returns the given
   * URL if it can not be resolved.
   */
  resolveUrl(url: string): string {
    return this.resolver.canResolve(url) ? this.resolver.resolve(url) : url;
  }
}
