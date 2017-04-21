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

import * as jsdoc from '../javascript/jsdoc';
import {Annotation as JsDocAnnotation} from '../javascript/jsdoc';
import {ImmutableArray} from '../model/immutable';
import {Class, Document, Element, ElementBase, LiteralValue, Privacy, Property, ScannedAttribute, ScannedElement, ScannedElementBase, ScannedEvent, ScannedMethod, ScannedProperty, Severity, SourceRange, Warning} from '../model/model';
import {ScannedReference} from '../model/reference';

import {Behavior, ScannedBehaviorAssignment} from './behavior';
import {DomModule} from './dom-module-scanner';
import {JavascriptDatabindingExpression} from './expression-scanner';

export interface BasePolymerProperty {
  published?: boolean;
  notify?: boolean;
  observer?: string;
  observerNode?: estree.Expression|estree.Pattern;
  observerExpression?: JavascriptDatabindingExpression;
  reflectToAttribute?: boolean;
  computedExpression?: JavascriptDatabindingExpression;
  /**
   * True if the property is part of Polymer's element configuration syntax.
   *
   * e.g. 'properties', 'is', 'extends', etc
   */
  isConfiguration?: boolean;
}

export interface ScannedPolymerProperty extends ScannedProperty,
                                                BasePolymerProperty {}
export interface PolymerProperty extends Property, BasePolymerProperty {}

export class LocalId {
  name: string;
  range: SourceRange;

  constructor(name: string, range: SourceRange) {
    this.name = name;
    this.range = range;
  }
}

export interface Observer {
  javascriptNode: estree.Expression|estree.SpreadElement;
  expression: LiteralValue;
  parsedExpression: JavascriptDatabindingExpression|undefined;
}

export interface Options {
  tagName: string|undefined;
  className: string|undefined;
  superClass: ScannedReference|undefined;
  mixins: ScannedReference[];
  extends: string|undefined;
  jsdoc: JsDocAnnotation;
  description: string|undefined;
  properties: ScannedProperty[];
  methods: ScannedMethod[];
  attributes: ScannedAttribute[];
  observers: Observer[];
  listeners: {event: string, handler: string}[];
  behaviors: ScannedBehaviorAssignment[];

  demos: {desc: string; path: string}[];
  events: ScannedEvent[];

  abstract: boolean;
  privacy: Privacy;
  astNode: any;
  sourceRange: SourceRange|undefined;
}

export interface ScannedPolymerExtension extends ScannedElementBase {
  properties: ScannedPolymerProperty[];
  methods: ScannedMethod[];
  observers: Observer[];
  listeners: {event: string, handler: string}[];
  behaviorAssignments: ScannedBehaviorAssignment[];
  // FIXME(rictic): domModule and scriptElement aren't known at a file local
  //     level. Remove them here, they should only exist on PolymerElement.
  domModule?: dom5.Node;
  scriptElement?: dom5.Node;
  // TODO(justinfagnani): Not Polymer-specific, and hopefully not necessary
  pseudo: boolean;

  addProperty(prop: ScannedPolymerProperty): void;
}

export function addProperty(
    target: ScannedPolymerExtension, prop: ScannedPolymerProperty) {
  target.properties.push(prop);
  const attributeName = propertyToAttributeName(prop.name);
  // Don't produce attributes or events for nonpublic properties, properties
  // that aren't in Polymer's `properties` block (i.e. not published),
  // or properties whose names can't be converted into attribute names.
  if ((prop.privacy && prop.privacy !== 'public') || !attributeName ||
      !prop.published) {
    return;
  }
  target.attributes.push({
    name: attributeName,
    sourceRange: prop.sourceRange,
    description: prop.description,
    type: prop.type,
    changeEvent: prop.notify ? `${attributeName}-changed` : undefined
  });
  if (prop.notify) {
    target.events.push({
      name: `${attributeName}-changed`,
      description: `Fired when the \`${prop.name}\` property changes.`,
      sourceRange: prop.sourceRange,
      astNode: prop.astNode,
      warnings: [],
      params: []
    });
  }
}

export function addMethod(
    target: ScannedPolymerExtension, method: ScannedMethod) {
  target.methods.push(method);
}

/**
 * The metadata for a single polymer element
 */
export class ScannedPolymerElement extends ScannedElement implements
    ScannedPolymerExtension {
  properties: ScannedPolymerProperty[] = [];
  methods: ScannedMethod[] = [];
  observers: Observer[] = [];
  listeners: {event: string, handler: string}[] = [];
  behaviorAssignments: ScannedBehaviorAssignment[] = [];
  // FIXME(rictic): domModule and scriptElement aren't known at a file local
  //     level. Remove them here, they should only exist on PolymerElement.
  domModule?: dom5.Node;
  scriptElement?: dom5.Node;
  // Indicates if an element is a pseudo element
  pseudo: boolean = false;
  abstract: boolean = false;

  constructor(options: Options) {
    super();
    this.tagName = options.tagName;
    this.className = options.className;
    this.superClass = options.superClass;
    this.mixins = options.mixins;
    this.extends = options.extends;
    this.jsdoc = options.jsdoc;
    this.description = options.description || '';
    this.attributes = options.attributes;
    this.observers = options.observers;
    this.listeners = options.listeners;
    this.behaviorAssignments = options.behaviors;
    this.demos = options.demos;
    this.events = options.events;
    this.abstract = options.abstract;
    this.privacy = options.privacy;
    this.astNode = options.astNode;
    this.sourceRange = options.sourceRange;

    if (options.properties) {
      options.properties.forEach((p) => this.addProperty(p));
    }
    if (options.methods) {
      options.methods.forEach((m) => this.addMethod(m));
    }
    this.summary = this.summary ||
        jsdoc.getTag(this.jsdoc, 'summary', 'description') || '';
  }

  addProperty(prop: ScannedPolymerProperty) {
    addProperty(this, prop);
  }

  addMethod(method: ScannedMethod) {
    addMethod(this, method);
  }

  resolve(document: Document): PolymerElement {
    this.applyJsdocDemoTags(document.url);
    return new PolymerElement(this, document);
  }
}

export interface PolymerExtension extends ElementBase {
  properties: PolymerProperty[];

  observers: ImmutableArray < {
    javascriptNode: estree.Expression|estree.SpreadElement,
        expression: LiteralValue,
        parsedExpression: JavascriptDatabindingExpression|undefined;
  }
  > ;
  listeners: ImmutableArray<{event: string, handler: string}>;
  behaviorAssignments: ImmutableArray<ScannedBehaviorAssignment>;
  scriptElement?: dom5.Node;
  localIds: ImmutableArray<LocalId>;

  emitPropertyMetadata(property: PolymerProperty): any;
}

declare module '../model/queryable' {
  interface FeatureKindMap {
    'polymer-element': PolymerElement;
    'pseudo-element': Element;
  }
}

export class PolymerElement extends Element implements PolymerExtension {
  readonly properties: PolymerProperty[];
  readonly observers: ImmutableArray<Observer> = [];
  readonly listeners: ImmutableArray<{event: string, handler: string}> = [];
  readonly behaviorAssignments: ImmutableArray<ScannedBehaviorAssignment> = [];
  readonly domModule?: dom5.Node;
  readonly scriptElement?: dom5.Node;
  readonly localIds: ImmutableArray<LocalId> = [];

  constructor(scannedElement: ScannedPolymerElement, document: Document) {
    super(scannedElement, document);
    this.kinds.add('polymer-element');

    this.observers = Array.from(scannedElement.observers);
    this.listeners = Array.from(scannedElement.listeners);
    this.behaviorAssignments = Array.from(scannedElement.behaviorAssignments);
    this.scriptElement = scannedElement.scriptElement;

    const domModules = scannedElement.tagName == null ?
        new Set<DomModule>() :
        document.getFeatures({
          kind: 'dom-module',
          id: scannedElement.tagName,
          imported: true,
          externalPackages: true
        });
    let domModule = undefined;
    if (domModules.size === 1) {
      // TODO(rictic): warn if this isn't true.
      domModule = domModules.values().next().value;
    }


    if (domModule) {
      this.description = this.description || domModule.comment || '';
      this.domModule = domModule.node;
      this.slots = domModule.slots.slice();
      this.localIds = domModule.localIds.slice();
    }

    if (scannedElement.pseudo) {
      this.kinds.add('pseudo-element');
    }
  }

  emitPropertyMetadata(property: PolymerProperty) {
    const polymerMetadata = {};
    const polymerMetadataFields = ['notify', 'observer', 'readOnly'];
    for (const field of polymerMetadataFields) {
      if (field in property) {
        polymerMetadata[field] = property[field];
      }
    }
    return {polymer: polymerMetadata};
  }

  protected _getPrototypeChain(document: Document, init: ScannedPolymerElement):
      Class[] {
    const prototypeChain = super._getPrototypeChain(document, init);

    const {warnings, behaviors} =
        getBehaviors(init.behaviorAssignments, document);

    this.warnings.push(...warnings);
    prototypeChain.push(...behaviors);
    return prototypeChain;
  }
}

/**
 * Implements Polymer core's translation of property names to attribute names.
 *
 * Returns null if the property name cannot be so converted.
 */
function propertyToAttributeName(propertyName: string): string|null {
  // Polymer core will not map a property name that starts with an uppercase
  // character onto an attribute.
  if (propertyName[0].toUpperCase() === propertyName[0]) {
    return null;
  }
  return propertyName.replace(
      /([A-Z])/g, (_: string, c1: string) => `-${c1.toLowerCase()}`);
}


export interface PropertyLike {
  name: string;
  sourceRange?: SourceRange;
  inheritedFrom?: string;
  privacy?: Privacy;
}

export function getBehaviors(
    behaviorAssignments: ImmutableArray<ScannedBehaviorAssignment>,
    document: Document) {
  const warnings: Warning[] = [];
  const behaviors: Behavior[] = [];
  for (const behavior of behaviorAssignments) {
    const foundBehaviors = document.getFeatures({
      kind: 'behavior',
      id: behavior.name,
      imported: true,
      externalPackages: true
    });
    if (foundBehaviors.size === 0) {
      warnings.push({
        message: `Unable to resolve behavior ` +
            `\`${behavior.name}\`. Did you import it? Is it annotated with ` +
            `@polymerBehavior?`,
        severity: Severity.ERROR,
        code: 'unknown-polymer-behavior',
        sourceRange: behavior.sourceRange
      });
      // Skip processing this behavior.
      continue;
    }
    if (foundBehaviors.size > 1) {
      warnings.push({
        message: `Found more than one behavior named ${behavior.name}.`,
        severity: Severity.WARNING,
        code: 'multiple-polymer-behaviors',
        sourceRange: behavior.sourceRange
      });
      // Don't skip processing this behavior, just take the most recently
      // declared instance.
    }
    const foundBehavior = Array.from(foundBehaviors)[foundBehaviors.size - 1];
    behaviors.push(foundBehavior);
  }
  return {warnings, behaviors};
}
