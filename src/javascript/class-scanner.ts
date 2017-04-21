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

import * as estree from 'estree';

import * as astValue from '../javascript/ast-value';
import {getIdentifierName, getNamespacedIdentifier} from '../javascript/ast-value';
import {Visitor} from '../javascript/estree-visitor';
import * as esutil from '../javascript/esutil';
import {JavaScriptDocument} from '../javascript/javascript-document';
import {JavaScriptScanner} from '../javascript/javascript-scanner';
import * as jsdoc from '../javascript/jsdoc';
import {ScannedClass, ScannedFeature, ScannedMethod, ScannedProperty, ScannedReference, Severity, SourceRange, Warning} from '../model/model';

import {extractObservers} from '../polymer/declaration-property-handlers';
import {getOrInferPrivacy} from '../polymer/js-utils';
import {Observer, ScannedPolymerElement} from '../polymer/polymer-element';
import {ScannedPolymerElementMixin} from '../polymer/polymer-element-mixin';
import {getIsValue, getMethods, getPolymerProperties, getStaticGetterValue} from '../polymer/polymer2-config';
import {MixinVisitor} from '../polymer/polymer2-mixin-scanner';


/**
 * Represents the first argument of a call to customElements.define.
 */
type TagNameExpression = ClassDotIsExpression|StringLiteralExpression;

/** The tagname was the `is` property on an class, like `MyElem.is` */
interface ClassDotIsExpression {
  type: 'is';
  className: string;
  classNameSourceRange: SourceRange;
}
/** The tag name was just a string literal. */
interface StringLiteralExpression {
  type: 'string-literal';
  value: string;
  sourceRange: SourceRange;
}


export interface ScannedAttribute extends ScannedFeature {
  name: string;
  type?: string;
}

/**
 * Find and classify classes from source code.
 *
 * Currently this has a bunch of Polymer stuff baked in that shouldn't be here
 * in order to support generating only one feature for stuff that's essentially
 * more specific kinds of classes, like Elements, PolymerElements, Mixins, etc.
 *
 * In a future change we'll add a mechanism whereby plugins can claim and
 * specialize classes.
 */
export class ClassScanner implements JavaScriptScanner {
  async scan(
      document: JavaScriptDocument, visit: (visitor: Visitor) => Promise<void>):
      Promise<Array<ScannedPolymerElement|ScannedClass|
                    ScannedPolymerElementMixin>> {
    const classFinder = new ClassFinder(document);
    const mixinFinder = new MixinVisitor(document);
    const elementDefinitionFinder =
        new CustomElementsDefineCallFinder(document);
    // Find all classes and all calls to customElements.define()
    await Promise.all([
      visit(classFinder),
      visit(elementDefinitionFinder),
      visit(mixinFinder)
    ]);
    const mixins = mixinFinder.mixins;

    const elementDefinitionsByClassName = new Map<string, ElementDefineCall>();
    // For classes that show up as expressions in the second argument position
    // of a customElements.define call.
    const elementDefinitionsByClassExpression =
        new Map<estree.ClassExpression, ElementDefineCall>();

    for (const defineCall of elementDefinitionFinder.calls) {
      // MaybeChainedIdentifier is invented below. It's like Identifier, but it
      // includes 'Polymer.Element' as a name.
      if (defineCall.clazz.type === 'MaybeChainedIdentifier') {
        elementDefinitionsByClassName.set(defineCall.clazz.name, defineCall);
      } else {
        elementDefinitionsByClassExpression.set(defineCall.clazz, defineCall);
      }
    }
    // TODO(rictic): emit ElementDefineCallFeatures for define calls that don't
    //     map to any local classes?

    const mixinClassExpressions = new Set<estree.Node>();
    for (const mixin of mixins) {
      if (mixin.classAstNode) {
        mixinClassExpressions.add(mixin.classAstNode);
      }
    }

    // Next we want to distinguish custom elements from other classes.
    const customElements: CustomElementDefinition[] = [];
    const normalClasses = [];
    for (const clazz of classFinder.classes) {
      if (mixinClassExpressions.has(clazz.astNode)) {
        // This class is a mixin and has already been handled as such.
        continue;
      }
      // Class expressions inside the customElements.define call
      if (clazz.astNode.type === 'ClassExpression') {
        const definition =
            elementDefinitionsByClassExpression.get(clazz.astNode);
        if (definition) {
          customElements.push({clazz, definition});
          continue;
        }
      }
      // Classes whose names are referenced in a same-file customElements.define
      const definition = elementDefinitionsByClassName.get(clazz.name!) ||
          elementDefinitionsByClassName.get(clazz.localName!);
      if (definition) {
        customElements.push({clazz, definition});
        continue;
      }
      // Classes explicitly defined as elements in their jsdoc tags.
      // TODO(rictic): swap to new jsdoc tag here.
      //     See: https://github.com/Polymer/polymer-analyzer/issues/605
      if (jsdoc.hasTag(clazz.jsdoc, 'polymerElement')) {
        customElements.push({clazz});
        continue;
      }
      // Classes that aren't custom elements, or at least, aren't obviously.
      normalClasses.push(clazz);
    }

    const scannedFeatures: (ScannedPolymerElement|ScannedClass|
                            ScannedPolymerElementMixin)[] = [];
    for (const element of customElements) {
      scannedFeatures.push(this._makeElementFeature(element, document));
    }
    for (const scannedClass of normalClasses) {
      scannedFeatures.push(scannedClass);
    }
    for (const mixin of mixins) {
      scannedFeatures.push(mixin);
    }

    // TODO(rictic): gather up the warnings from these visitors and return them
    // too.
    // const warnings =
    // elementDefinitionFinder.warnings.concat(
    // mixinFinder.warnings).concat(classFinder.warnings);

    return scannedFeatures;
  }

  private _makeElementFeature(
      element: CustomElementDefinition,
      document: JavaScriptDocument): ScannedPolymerElement {
    const clazz = element.clazz;
    const astNode = element.clazz.astNode;
    const docs = element.clazz.jsdoc;
    let tagName: string|undefined = undefined;
    // TODO(rictic): support `@customElements explicit-tag-name` from jsdoc
    if (element.definition &&
        element.definition.tagName.type === 'string-literal') {
      tagName = element.definition.tagName.value;
    } else if (
        astNode.type === 'ClassExpression' ||
        astNode.type === 'ClassDeclaration') {
      tagName = getIsValue(astNode);
    }
    let warnings: Warning[] = [];

    let scannedElement: ScannedPolymerElement;
    let properties: ScannedProperty[] = [];
    let methods: ScannedMethod[] = [];
    let observers: Observer[] = [];

    // This will cover almost all classes, except those defined only by
    // applying a mixin. e.g.   const MyElem = Mixin(HTMLElement)
    if (astNode.type === 'ClassExpression' ||
        astNode.type === 'ClassDeclaration') {
      const observersResult = this._getObservers(astNode, document);
      observers = [];
      if (observersResult) {
        observers = observersResult.observers;
        warnings = warnings.concat(observersResult.warnings);
      }
      properties = getPolymerProperties(astNode, document);
      methods = getMethods(astNode, document);
    }

    // TODO(justinfagnani): Infer mixin applications and superclass from AST.
    scannedElement = new ScannedPolymerElement({
      className: clazz.name,
      tagName,
      astNode,
      properties,
      methods,
      observers,
      events: esutil.getEventComments(astNode),
      attributes: [],
      behaviors: [],
      demos: [],
      extends: jsdoc.getTag(docs, 'extends', 'name') || undefined,
      listeners: [],

      description: clazz.description,
      sourceRange: clazz.sourceRange,
      superClass: clazz.superClass,
      jsdoc: clazz.jsdoc,
      abstract: clazz.abstract,
      mixins: clazz.mixins,
      privacy: clazz.privacy
    });

    if (astNode.type === 'ClassExpression' ||
        astNode.type === 'ClassDeclaration') {
      // If a class defines observedAttributes, it overrides what the base
      // classes defined.
      // TODO(justinfagnani): define and handle composition patterns.
      const observedAttributes = this._getObservedAttributes(astNode, document);

      if (observedAttributes != null) {
        scannedElement.attributes = observedAttributes;
      }
    }

    warnings.forEach((w) => scannedElement.warnings.push(w));

    return scannedElement;
  }

  private _getObservers(
      node: estree.ClassDeclaration|estree.ClassExpression,
      document: JavaScriptDocument) {
    const returnedValue = getStaticGetterValue(node, 'observers');
    if (returnedValue) {
      return extractObservers(returnedValue, document);
    }
  }

  private _getObservedAttributes(
      node: estree.ClassDeclaration|estree.ClassExpression,
      document: JavaScriptDocument) {
    const returnedValue = getStaticGetterValue(node, 'observedAttributes');
    if (returnedValue && returnedValue.type === 'ArrayExpression') {
      return this._extractAttributesFromObservedAttributes(
          returnedValue, document);
    }
  }

  /**
   * Extract attributes from the array expression inside a static
   * observedAttributes method.
   *
   * e.g.
   *     static get observedAttributes() {
   *       return [
   *         /** @type {boolean} When given the element is totally inactive *\/
   *         'disabled',
   *         /** @type {boolean} When given the element is expanded *\/
   *         'open'
   *       ];
   *     }
   */
  private _extractAttributesFromObservedAttributes(
      arry: estree.ArrayExpression, document: JavaScriptDocument) {
    const results: ScannedAttribute[] = [];
    for (const expr of arry.elements) {
      const value = astValue.expressionToValue(expr);
      if (value && typeof value === 'string') {
        let description = '';
        let type: string|null = null;
        const comment = esutil.getAttachedComment(expr);
        if (comment) {
          const annotation = jsdoc.parseJsdoc(comment);
          description = annotation.description || description;
          const tags = annotation.tags || [];
          for (const tag of tags) {
            if (tag.tag === 'type') {
              type = type || tag.type;
            }
            description = description || tag.description || '';
          }
        }
        const attribute: ScannedAttribute = {
          name: value,
          description: description,
          sourceRange: document.sourceRangeForNode(expr),
          astNode: expr,
          warnings: [],
        };
        if (type) {
          attribute.type = type;
        }
        results.push(attribute);
      }
    }
    return results;
  }
}

interface CustomElementDefinition {
  clazz: ScannedClass;
  definition?: ElementDefineCall;
}

/**
 * Finds all classes and matches them up with their best jsdoc comment.
 */
class ClassFinder implements Visitor {
  readonly classes: ScannedClass[] = [];
  private readonly alreadyMatched = new Set<estree.ClassExpression>();
  private readonly _document: JavaScriptDocument;

  constructor(document: JavaScriptDocument) {
    this._document = document;
  }

  enterAssignmentExpression(
      node: estree.AssignmentExpression, parent: estree.Node) {
    this.handleGeneralAssignment(
        astValue.getIdentifierName(node.left), node.right, node, parent);
  }

  enterVariableDeclarator(
      node: estree.VariableDeclarator, parent: estree.Node) {
    if (node.init) {
      this.handleGeneralAssignment(
          astValue.getIdentifierName(node.id), node.init, node, parent);
    }
  }

  /** Generalizes over variable declarators and assignment expressions. */
  private handleGeneralAssignment(
      assignedName: string|undefined, value: estree.Expression,
      assignment: estree.VariableDeclarator|estree.AssignmentExpression,
      statement: estree.Node) {
    const comment = esutil.getAttachedComment(value) ||
        esutil.getAttachedComment(assignment) ||
        esutil.getAttachedComment(statement) || '';
    const doc = jsdoc.parseJsdoc(comment);
    if (value.type === 'ClassExpression') {
      const name =
          assignedName || value.id && astValue.getIdentifierName(value.id);

      this._classFound(name, doc, value);
    } else {
      // TODO(rictic): remove the @polymerElement tag here
      //     See: https://github.com/Polymer/polymer-analyzer/issues/605
      if (jsdoc.hasTag(doc, 'polymerElement')) {
        this._classFound(assignedName, doc, value);
      }
    }
  }

  enterClassExpression(node: estree.ClassExpression, parent: estree.Node) {
    // Class expressions may be on the right hand side of assignments, so
    // we may have already handled this expression from the parent or
    // grandparent node. Class declarations can't be on the right hand side of
    // assignments, so they'll definitely only be handled once.
    if (this.alreadyMatched.has(node)) {
      return;
    }

    const name = node.id ? astValue.getIdentifierName(node.id) : undefined;
    const comment = esutil.getAttachedComment(node) ||
        esutil.getAttachedComment(parent) || '';
    this._classFound(name, jsdoc.parseJsdoc(comment), node);
  }

  enterClassDeclaration(node: estree.ClassDeclaration, parent: estree.Node) {
    const name = astValue.getIdentifierName(node.id);
    const comment = esutil.getAttachedComment(node) ||
        esutil.getAttachedComment(parent) || '';
    this._classFound(name, jsdoc.parseJsdoc(comment), node);
  }

  private _classFound(
      name: string|undefined, doc: jsdoc.Annotation, astNode: estree.Node) {
    const namespacedName = name && getNamespacedIdentifier(name, doc);

    const warnings: Warning[] = [];
    // TODO(rictic): scan the constructor and look for assignments to this.foo
    //     to determine properties.
    this.classes.push(new ScannedClass(
        namespacedName,
        name,
        astNode,
        doc,
        (doc.description || '').trim(),
        this._document.sourceRangeForNode(astNode)!,
        [],
        getMethods(astNode, this._document),
        this._getExtends(astNode, doc, warnings, this._document),
        jsdoc.getMixins(this._document, astNode, doc, warnings),
        getOrInferPrivacy(namespacedName || '', doc, false),
        warnings,
        jsdoc.hasTag(doc, 'abstract')));
    if (astNode.type === 'ClassExpression') {
      this.alreadyMatched.add(astNode);
    }
  }

  /**
   * Returns the name of the superclass, if any.
   */
  private _getExtends(
      node: estree.Node, docs: jsdoc.Annotation, warnings: Warning[],
      document: JavaScriptDocument): ScannedReference|undefined {
    const extendsAnnotations =
        docs.tags!.filter((tag) => tag.tag === 'extends');

    // prefer @extends annotations over extends clauses
    if (extendsAnnotations.length > 0) {
      const extendsId = extendsAnnotations[0].name;
      // TODO(justinfagnani): we need source ranges for jsdoc annotations
      const sourceRange = document.sourceRangeForNode(node)!;
      if (extendsId == null) {
        warnings.push({
          code: 'class-extends-annotation-no-id',
          message: '@extends annotation with no identifier',
          severity: Severity.WARNING, sourceRange,
        });
      } else {
        return new ScannedReference(extendsId, sourceRange);
      }
    } else if (
        node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      // If no @extends tag, look for a superclass.
      const superClass = node.superClass;
      if (superClass != null) {
        const extendsId = getIdentifierName(superClass);
        if (extendsId != null) {
          const sourceRange = document.sourceRangeForNode(superClass)!;
          return new ScannedReference(extendsId, sourceRange);
        }
      }
    }
  }
}

interface ElementDefineCall {
  tagName: TagNameExpression;
  clazz: ElementClassExpression;
}

type ElementClassExpression = estree.ClassExpression|{
  type: 'MaybeChainedIdentifier';
  name: string, sourceRange: SourceRange
};

/** Finds calls to customElements.define() */
class CustomElementsDefineCallFinder implements Visitor {
  readonly warnings: Warning[] = [];
  readonly calls: ElementDefineCall[] = [];
  private readonly _document: JavaScriptDocument;

  constructor(document: JavaScriptDocument) {
    this._document = document;
  }

  enterCallExpression(node: estree.CallExpression) {
    const callee = astValue.getIdentifierName(node.callee);
    if (!(callee === 'window.customElements.define' ||
          callee === 'customElements.define')) {
      return;
    }

    const tagNameExpression = this._getTagNameExpression(node.arguments[0]);
    if (tagNameExpression == null) {
      return;
    }
    const elementClassExpression =
        this._getElementClassExpression(node.arguments[1]);
    if (elementClassExpression == null) {
      return;
    }
    this.calls.push(
        {tagName: tagNameExpression, clazz: elementClassExpression});
  }

  private _getTagNameExpression(expression: estree.Node|
                                undefined): TagNameExpression|undefined {
    if (expression == null) {
      return;
    }
    const tryForLiteralString = astValue.expressionToValue(expression);
    if (tryForLiteralString != null &&
        typeof tryForLiteralString === 'string') {
      return {
        type: 'string-literal',
        value: tryForLiteralString,
        sourceRange: this._document.sourceRangeForNode(expression)!
      };
    }
    if (expression.type === 'MemberExpression') {
      // Might be something like MyElement.is
      const isPropertyNameIs = (expression.property.type === 'Identifier' &&
                                expression.property.name === 'is') ||
          (astValue.expressionToValue(expression.property) === 'is');
      const className = astValue.getIdentifierName(expression.object);
      if (isPropertyNameIs && className) {
        return {
          type: 'is',
          className,
          classNameSourceRange:
              this._document.sourceRangeForNode(expression.object)!
        };
      }
    }
    this.warnings.push({
      code: 'cant-determine-element-tagname',
      message:
          `Unable to evaluate this expression down to a definitive string ` +
          `tagname.`,
      severity: Severity.WARNING,
      sourceRange: this._document.sourceRangeForNode(expression)!
    });
    return undefined;
  }

  private _getElementClassExpression(elementDefn: estree.Node|
                                     undefined): ElementClassExpression|null {
    if (elementDefn == null) {
      return null;
    }
    const className = astValue.getIdentifierName(elementDefn);
    if (className) {
      return {
        type: 'MaybeChainedIdentifier',
        name: className,
        sourceRange: this._document.sourceRangeForNode(elementDefn)!
      };
    }
    if (elementDefn.type === 'ClassExpression') {
      return elementDefn;
    }
    this.warnings.push({
      code: 'cant-determine-element-class',
      message: `Unable to evaluate this expression down to a class reference.`,
      severity: Severity.WARNING,
      sourceRange: this._document.sourceRangeForNode(elementDefn)!
    });
    return null;
  }
}
