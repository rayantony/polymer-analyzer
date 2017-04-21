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

import {getIdentifierName, getNamespacedIdentifier} from '../javascript/ast-value';
import {Visitor} from '../javascript/estree-visitor';
import * as esutil from '../javascript/esutil';
import {JavaScriptDocument} from '../javascript/javascript-document';
import {JavaScriptScanner} from '../javascript/javascript-scanner';
import * as jsdoc from '../javascript/jsdoc';
import {Severity} from '../model/model';

import {ScannedBehavior, ScannedBehaviorAssignment} from './behavior';
import {declarationPropertyHandlers, PropertyHandlers} from './declaration-property-handlers';
import * as docs from './docs';
import {getOrInferPrivacy, toScannedPolymerProperty} from './js-utils';

interface KeyFunc<T> {
  (value: T): any;
}

function dedupe<T>(array: T[], keyFunc: KeyFunc<T>): T[] {
  const bucket = {};
  array.forEach((el) => {
    const key = keyFunc(el);
    if (key in bucket) {
      return;
    }
    bucket[key] = el;
  });
  const returned = <Array<T>>[];
  Object.keys(bucket).forEach((k) => {
    returned.push(bucket[k]);
  });
  return returned;
}

const templatizer = 'Polymer.Templatizer';

export class BehaviorScanner implements JavaScriptScanner {
  async scan(
      document: JavaScriptDocument,
      visit: (visitor: Visitor) => Promise<void>): Promise<ScannedBehavior[]> {
    const visitor = new BehaviorVisitor(document);
    await visit(visitor);
    return Array.from(visitor.behaviors);
  }
}

class BehaviorVisitor implements Visitor {
  /** The behaviors we've found. */
  behaviors = new Set<ScannedBehavior>();

  currentBehavior: ScannedBehavior|null = null;
  propertyHandlers: PropertyHandlers|null = null;

  document: JavaScriptDocument;
  constructor(document: JavaScriptDocument) {
    this.document = document;
  }

  /**
   * Look for object declarations with @polymerBehavior in the docs.
   */
  enterVariableDeclaration(
      node: estree.VariableDeclaration, _parent: estree.Node) {
    if (node.declarations.length !== 1) {
      return;  // Ambiguous.
    }
    this._initBehavior(node, () => {
      const id = node.declarations[0].id;
      return esutil.objectKeyToString(id)!;
    });
  }

  /**
   * Look for object assignments with @polymerBehavior in the docs.
   */
  enterAssignmentExpression(
      node: estree.AssignmentExpression, parent: estree.Node) {
    this._initBehavior(parent, () => esutil.objectKeyToString(node.left)!);
  }

  /**
   * We assume that the object expression after such an assignment is the
   * behavior's declaration. Seems to be a decent assumption for now.
   */
  enterObjectExpression(node: estree.ObjectExpression, _parent: estree.Node) {
    if (!this.currentBehavior || !this.propertyHandlers) {
      return;
    }

    for (let i = 0; i < node.properties.length; i++) {
      const prop = node.properties[i];
      const name = esutil.objectKeyToString(prop.key);
      if (!name) {
        this.currentBehavior.warnings.push({
          code: 'cant-determine-name',
          message:
              `Unable to determine property name from expression of type ${
                                                                           node.type
                                                                         }`,
          severity: Severity.WARNING,
          sourceRange: this.document.sourceRangeForNode(node)!
        });
        continue;
      }
      if (name in this.propertyHandlers) {
        this.propertyHandlers[name](prop.value);
      } else {
        this.currentBehavior.addProperty(toScannedPolymerProperty(
            prop, this.document.sourceRangeForNode(prop)!));
      }
    }
    this._finishBehavior();
  }

  private _startBehavior(behavior: ScannedBehavior) {
    console.assert(this.currentBehavior == null);
    this.currentBehavior = behavior;
  }

  private _finishBehavior() {
    console.assert(this.currentBehavior != null);
    this.behaviors.add(this.currentBehavior!);
    this.currentBehavior = null;
  }

  private _initBehavior(node: estree.Node, getName: () => string) {
    const comment = esutil.getAttachedComment(node);
    const symbol = getName();
    // Quickly filter down to potential candidates.
    if (!comment || comment.indexOf('@polymerBehavior') === -1) {
      if (symbol !== templatizer) {
        return;
      }
    }
    const parsedJsdocs = jsdoc.parseJsdoc(comment || '');
    if (!jsdoc.hasTag(parsedJsdocs, 'polymerBehavior')) {
      if (symbol !== templatizer) {
        return;
      }
    }

    this._startBehavior(new ScannedBehavior({
      astNode: node,
      description: parsedJsdocs.description,
      events: esutil.getEventComments(node),
      sourceRange: this.document.sourceRangeForNode(node),
      privacy: getOrInferPrivacy(symbol, parsedJsdocs, false),
      abstract: jsdoc.hasTag(parsedJsdocs, 'abstract'),
      attributes: [],
      properties: [],
      behaviors: [],
      className: undefined,
      demos: [],
      extends: undefined,
      jsdoc: parsedJsdocs,
      listeners: [],
      methods: [],
      mixins: [],
      observers: [],
      superClass: undefined,
      tagName: undefined
    }));
    const behavior = this.currentBehavior!;

    this.propertyHandlers =
        declarationPropertyHandlers(behavior, this.document);

    docs.annotateElementHeader(behavior);
    behavior.className =
        jsdoc.getTag(behavior.jsdoc, 'polymerBehavior', 'name') ||
        getNamespacedIdentifier(symbol, behavior.jsdoc);
    if (!behavior.className) {
      throw new Error(
          `Unable to determine name for @polymerBehavior: ${comment}`);
    }

    behavior.privacy =
        getOrInferPrivacy(behavior.className, behavior.jsdoc, false);
    this._parseChainedBehaviors(node);

    this.currentBehavior = this.mergeBehavior(behavior);
    this.propertyHandlers =
        declarationPropertyHandlers(this.currentBehavior, this.document);

    // Some behaviors are just lists of other behaviors. If this is one then
    // add it to behaviors right away.
    if (isSimpleBehaviorArray(behaviorExpression(node))) {
      this._finishBehavior();
    }
  }

  /**
   * merges behavior with preexisting behavior with the same name.
   * here to support multiple @polymerBehavior tags referring
   * to same behavior. See iron-multi-selectable for example.
   */
  mergeBehavior(newBehavior: ScannedBehavior): ScannedBehavior {
    const isBehaviorImpl = (b: ScannedBehaviorAssignment) => {
      // filter out BehaviorImpl
      return b.name.indexOf(newBehavior.className) === -1;
    };
    for (const behavior of this.behaviors) {
      if (newBehavior.className !== behavior.className) {
        continue;
      }
      // merge desc, longest desc wins
      if (newBehavior.description) {
        if (behavior.description) {
          if (newBehavior.description.length > behavior.description.length)
            behavior.description = newBehavior.description;
        } else {
          behavior.description = newBehavior.description;
        }
      }
      // TODO(justinfagnani): move into ScannedBehavior
      behavior.demos = behavior.demos.concat(newBehavior.demos);
      behavior.events = behavior.events.concat(newBehavior.events);
      behavior.events = dedupe(behavior.events, (e) => e.name);
      for (const property of newBehavior.properties) {
        behavior.addProperty(property);
      }
      behavior.observers = behavior.observers.concat(newBehavior.observers);
      behavior.behaviorAssignments =
          (behavior.behaviorAssignments)
              .concat(newBehavior.behaviorAssignments)
              .filter(isBehaviorImpl);
      return behavior;
    }
    return newBehavior;
  }

  _parseChainedBehaviors(node: estree.Node) {
    if (this.currentBehavior == null) {
      throw new Error(
          `_parsedChainedBehaviors was called without a current behavior.`);
    }
    // if current behavior is part of an array, it gets extended by other
    // behaviors
    // inside the array. Ex:
    // Polymer.IronMultiSelectableBehavior = [ {....},
    // Polymer.IronSelectableBehavior]
    // We add these to behaviors array
    const expression = behaviorExpression(node);
    const chained: Array<ScannedBehaviorAssignment> = [];
    if (expression && expression.type === 'ArrayExpression') {
      for (const arrElement of expression.elements) {
        const behaviorName = getIdentifierName(arrElement);
        if (behaviorName) {
          chained.push({
            name: behaviorName,
            sourceRange: this.document.sourceRangeForNode(arrElement)!
          });
        }
      }
      if (chained.length > 0) {
        this.currentBehavior.behaviorAssignments = chained;
      }
    }
  }
}

/**
 * gets the expression representing a behavior from a node.
 */
function behaviorExpression(node: estree.Node): estree.Node|undefined {
  switch (node.type) {
    case 'ExpressionStatement':
      // need to cast to `any` here because ExpressionStatement is super
      // super general. this code is suspicious.
      return (<any>node).expression.right;
    case 'VariableDeclaration':
      return node.declarations.length > 0 ? node.declarations[0].init :
                                            undefined;
  }
}

/**
 * checks whether an expression is a simple array containing only member
 * expressions or identifiers.
 */
function isSimpleBehaviorArray(expression: estree.Node|undefined): boolean {
  if (!expression || expression.type !== 'ArrayExpression') {
    return false;
  }
  for (const element of expression.elements) {
    if (element.type !== 'MemberExpression' && element.type !== 'Identifier') {
      return false;
    }
  }
  return true;
}
