/**
 * @license
 * Copyright (c) 2015 The Polymer Project Authors. All rights reserved.
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
import * as dom5 from 'dom5';
import * as estree from 'estree';

import {Annotation as JsDocAnnotation} from '../javascript/jsdoc';
import {Class, Document, ElementMixin, Method, Privacy, ScannedElementMixin, ScannedMethod, ScannedReference, SourceRange} from '../model/model';

import {ScannedBehaviorAssignment} from './behavior';
import {getOrInferPrivacy} from './js-utils';
import {addMethod, addProperty, getBehaviors, LocalId, Observer, PolymerExtension, PolymerProperty, ScannedPolymerExtension, ScannedPolymerProperty} from './polymer-element';

export interface Options {
  name: string;
  jsdoc: JsDocAnnotation;
  description: string;
  summary: string;
  privacy: Privacy;
  sourceRange: SourceRange;
  mixins: ScannedReference[];
  astNode: estree.Node;
  classAstNode?: estree.Node;
}

export class ScannedPolymerElementMixin extends ScannedElementMixin implements
    ScannedPolymerExtension {
  readonly properties: ScannedPolymerProperty[] = [];
  readonly methods: ScannedMethod[] = [];
  readonly observers: Observer[] = [];
  readonly listeners: {event: string, handler: string}[] = [];
  readonly behaviorAssignments: ScannedBehaviorAssignment[] = [];
  // FIXME(rictic): domModule and scriptElement aren't known at a file local
  //     level. Remove them here, they should only exist on PolymerElement.
  domModule: dom5.Node|undefined = undefined;
  scriptElement: dom5.Node|undefined = undefined;
  pseudo: boolean = false;
  readonly abstract: boolean = false;
  readonly sourceRange: SourceRange;
  classAstNode?: estree.Node;

  constructor({
    name,
    jsdoc,
    description,
    summary,
    privacy,
    sourceRange,
    mixins,
    astNode,
    classAstNode
  }: Options) {
    super({name});
    this.jsdoc = jsdoc;
    this.description = description;
    this.summary = summary;
    this.privacy = privacy;
    this.sourceRange = sourceRange;
    this.mixins = mixins;
    this.astNode = astNode;
    this.classAstNode = classAstNode;
  }

  addProperty(prop: ScannedPolymerProperty) {
    addProperty(this, prop);
  }

  addMethod(method: ScannedMethod) {
    // methods are only public by default if they're documented.
    method.privacy = getOrInferPrivacy(method.name, method.jsdoc, true);
    addMethod(this, method);
  }

  resolve(document: Document): PolymerElementMixin {
    return new PolymerElementMixin(this, document);
  }
}

declare module '../model/queryable' {
  interface FeatureKindMap {
    'polymer-element-mixin': PolymerElementMixin;
  }
}
export class PolymerElementMixin extends ElementMixin implements
    PolymerExtension {
  readonly properties: PolymerProperty[];
  readonly methods: Method[];

  readonly observers: Observer[];
  readonly listeners: {event: string, handler: string}[];
  readonly behaviorAssignments: ScannedBehaviorAssignment[] = [];
  readonly domModule?: dom5.Node;
  readonly scriptElement?: dom5.Node;
  readonly localIds: LocalId[] = [];
  readonly pseudo: boolean;

  constructor(scannedMixin: ScannedPolymerElementMixin, document: Document) {
    super(scannedMixin, document);
    this.kinds.add('polymer-element-mixin');
    this.domModule = scannedMixin.domModule;
    this.pseudo = scannedMixin.pseudo;
    this.scriptElement = scannedMixin.scriptElement;
    this.slots = scannedMixin.slots;
    this.behaviorAssignments = Array.from(scannedMixin.behaviorAssignments);
    this.observers = Array.from(scannedMixin.observers);
  }

  emitPropertyMetadata(property: PolymerProperty) {
    const polymerMetadata: any = {};
    const polymerMetadataFields = ['notify', 'observer', 'readOnly'];
    for (const field of polymerMetadataFields) {
      if (field in property) {
        polymerMetadata[field] = property[field];
      }
    }
    return {polymer: polymerMetadata};
  }

  protected _getPrototypeChain(
      document: Document, init: ScannedPolymerElementMixin): Class[] {
    const prototypeChain = super._getPrototypeChain(document, init);

    const {warnings, behaviors} =
        getBehaviors(init.behaviorAssignments, document);
    this.warnings.push(...warnings);
    prototypeChain.push(...behaviors);
    return prototypeChain;
  }
}
