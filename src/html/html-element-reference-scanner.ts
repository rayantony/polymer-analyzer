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

import * as dom5 from 'dom5';
import {ASTNode, treeAdapters} from 'parse5';
import {ScannedElementReference} from '../model/element-reference';
import {HtmlVisitor, ParsedHtmlDocument} from './html-document';
import {HtmlScanner} from './html-scanner';

const isCustomElement = dom5.predicates.hasMatchingTagName(/(.+-)+.+/);

/**
 * Scans for HTML element references/uses in a given document.
 * All elements will be detected, including anything in <head>.
 * This scanner will not be loaded by default, but the custom
 * element extension of it will be.
 */
export class HtmlElementReferenceScanner implements HtmlScanner {
  matches(node: ASTNode): boolean {
    return !!node;
  }

  async scan(
      document: ParsedHtmlDocument,
      visit: (visitor: HtmlVisitor) => Promise<void>):
      Promise<ScannedElementReference[]> {
    const elements: ScannedElementReference[] = [];

    const visitor = (node: ASTNode) => {
      if (node.tagName && this.matches(node)) {
        const element = new ScannedElementReference(
            node.tagName, document.sourceRangeForNode(node)!, node);

        if (node.attrs) {
          for (const attr of node.attrs) {
            element.attributes.push({
              name: attr.name,
              value: attr.value,
              sourceRange: document.sourceRangeForAttribute(node, attr.name)!,
              nameSourceRange:
                  document.sourceRangeForAttributeName(node, attr.name)!,
              valueSourceRange:
                  document.sourceRangeForAttributeValue(node, attr.name)
            });
          }
        }

        elements.push(element);
      }

      // Descend into templates.
      if (node.tagName === 'template') {
        const content = treeAdapters.default.getTemplateContent(node);
        if (content) {
          dom5.nodeWalk(content, (n) => {
            visitor(n);
            return false;
          });
        }
      }
    };

    await visit(visitor);

    return elements;
  }
}

/**
 * Scans for custom element references/uses.
 * All custom elements will be detected except <dom-module>.
 * This is a default scanner.
 */
export class HtmlCustomElementReferenceScanner extends
    HtmlElementReferenceScanner {
  matches(node: ASTNode): boolean {
    return isCustomElement(node) && node.nodeName !== 'dom-module';
  }
}
