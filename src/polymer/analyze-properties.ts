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
import * as esutil from '../javascript/esutil';
import {JavaScriptDocument} from '../javascript/javascript-document';
import * as jsdoc from '../javascript/jsdoc';
import {Severity} from '../model/model';

import {parseExpressionInJsStringLiteral} from './expression-scanner';
import {toScannedPolymerProperty} from './js-utils';
import {ScannedPolymerProperty} from './polymer-element';

/**
 * Given a properties block (i.e. object literal), parses and extracts the
 * properties declared therein.
 *
 * @param node The value of the `properties` key in a Polymer 1 declaration, or
 *     the return value of the `properties` static getter in a Polymer 2 class.
 * @param document The containing JS document.
 */
export function analyzeProperties(
    node: estree.Node, document: JavaScriptDocument): ScannedPolymerProperty[] {
  const analyzedProps: ScannedPolymerProperty[] = [];

  if (node.type !== 'ObjectExpression') {
    return analyzedProps;
  }

  for (const property of node.properties) {
    const prop = toScannedPolymerProperty(
        property, document.sourceRangeForNode(property)!);

    // toScannedPolymerProperty does the wrong thing for us with type. We want
    // type to be undefined unless there's a positive signal for the type.
    // toScannedPolymerProperty will give Object because it infers based on the
    // property declaration.
    prop.type = undefined;
    const typeTag = jsdoc.getTag(prop.jsdoc, 'type');
    if (typeTag) {
      prop.type = typeTag.type || undefined;
    }
    prop.published = true;

    let isComputed = false;

    if (property.value.type === 'Identifier') {
      // If we've already got a type it's from jsdoc and thus canonical.
      if (!prop.type) {
        prop.type = property.value.name;
      }
    } else if (property.value.type !== 'ObjectExpression') {
      continue;
    } else {
      /**
       * Parse the expression inside a property object block. e.g.
       * property: {
       *   key: {
       *     type: String,
       *     notify: true,
       *     value: -1,
       *     readOnly: true,
       *     reflectToAttribute: true
       *   }
       * }
       */
      for (const propertyArg of property.value.properties) {
        const propertyKey = esutil.objectKeyToString(propertyArg.key);

        switch (propertyKey) {
          case 'type':
            // If we've already got a type, then it was found in the jsdocs,
            // and is canonical.
            if (!prop.type) {
              prop.type = esutil.objectKeyToString(propertyArg.value);
              if (prop.type === undefined) {
                prop.warnings.push({
                  code: 'invalid-property-type',
                  message: 'Invalid type in property object.',
                  severity: Severity.ERROR,
                  sourceRange: document.sourceRangeForNode(propertyArg)!
                });
              }
            }
            break;
          case 'notify':
            prop.notify = !!astValue.expressionToValue(propertyArg.value);
            break;
          case 'observer':
            const val = astValue.expressionToValue(propertyArg.value);
            prop.observerNode = propertyArg.value;
            const parseResult = parseExpressionInJsStringLiteral(
                document, propertyArg.value, 'identifierOnly');
            prop.warnings.push(...parseResult.warnings);
            prop.observerExpression = parseResult.databinding;
            if (val === undefined) {
              prop.observer = astValue.CANT_CONVERT;
            } else {
              prop.observer = JSON.stringify(val);
            }
            break;
          case 'readOnly':
            prop.readOnly = !!astValue.expressionToValue(propertyArg.value);
            break;
          case 'reflectToAttribute':
            prop.reflectToAttribute = !!astValue.expressionToValue(propertyArg);
            break;
          case 'computed':
            isComputed = true;
            const computedParseResult = parseExpressionInJsStringLiteral(
                document, propertyArg.value, 'callExpression');
            prop.warnings.push(...computedParseResult.warnings);
            prop.computedExpression = computedParseResult.databinding;
            break;
          case 'value':
            prop.default =
                JSON.stringify(astValue.expressionToValue(propertyArg.value));
            break;
          default:
            break;
        }
      }
    }

    if (isComputed) {
      prop.readOnly = true;
    }

    prop.type = esutil.CLOSURE_CONSTRUCTOR_MAP.get(prop.type!) || prop.type;

    if (!prop.type) {
      prop.warnings.push({
        code: 'no-type-for-property',
        message: 'Unable to determine type for property.',
        severity: Severity.WARNING,
        sourceRange: document.sourceRangeForNode(property)!
      });
    }

    analyzedProps.push(prop);
  }
  return analyzedProps;
};
