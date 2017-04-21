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


import {assert} from 'chai';
import * as path from 'path';

import {Analyzer} from '../../analyzer';
import {ClassScanner} from '../../javascript/class-scanner';
import {Visitor} from '../../javascript/estree-visitor';
import {JavaScriptParser} from '../../javascript/javascript-parser';
import {Class, Element, ElementMixin, ScannedClass, ScannedFeature} from '../../model/model';
import {FSUrlLoader} from '../../url-loader/fs-url-loader';
import {CodeUnderliner} from '../test-utils';

const fixturesDir = path.resolve(__dirname, '../static');
suite('Class', () => {
  const urlLoader = new FSUrlLoader(fixturesDir);
  const underliner = new CodeUnderliner(urlLoader);
  const analyzer = new Analyzer({urlLoader});

  async function getScannedFeatures(filename: string) {
    const file = await urlLoader.load(filename);
    const parser = new JavaScriptParser();
    const document = parser.parse(file, filename);
    const scanner = new ClassScanner();
    const visit = (visitor: Visitor) =>
        Promise.resolve(document.visit([visitor]));

    return await scanner.scan(document, visit);
  };

  async function getScannedClasses(filename: string): Promise<ScannedClass[]> {
    const features: ScannedFeature[] = await getScannedFeatures(filename);
    return features.filter((e) => e instanceof ScannedClass) as ScannedClass[];
  };

  async function getClasses(filename: string): Promise<Class[]> {
    const analysis = await analyzer.analyze([filename]);
    return Array.from(analysis.getFeatures({kind: 'class'}));
  };

  async function getTestProps(class_: ScannedClass|Class) {
    type TestPropsType = {
      name: string | undefined,
      description: string,
      privacy: string,
      properties?: any[],
      methods?: any[],
      warnings?: string[],
      mixins?: any[],
      superClass?: string,
    };
    const result: TestPropsType = {
      name: class_.name,
      description: class_.description,
      privacy: class_.privacy
    };
    if (class_.properties.length > 0) {
      result.properties = [];
      for (const {name} of class_.properties) {
        result.properties.push({name});
      }
    }
    if (class_.methods.length > 0) {
      result.methods = [];
      for (const m of class_.methods) {
        const method: any = {name: m.name, description: m.description};
        if (m.params && m.params.length > 0) {
          method.params = m.params.map((p) => {
            const param: any = {name: p.name};
            if (p.description != null) {
              param.description = p.description;
            }
            if (p.type != null) {
              param.type = p.type;
            }
            return param;
          });
        }
        if (m.return ) {
          method.return = m.return;
        }
        if (m['inheritedFrom']) {
          method.inheritedFrom = m['inheritedFrom'];
        }
        result.methods.push(method);
      }
    }
    if (class_.mixins.length > 0) {
      result.mixins = [];
      for (const {identifier} of class_.mixins) {
        result.mixins.push({identifier});
      }
    }
    if (class_.warnings.length > 0) {
      result.warnings = await underliner.underline(class_.warnings);
    }
    if (class_.superClass) {
      result.superClass = class_.superClass.identifier;
    }
    return result;
  };

  suite('scanning', () => {
    test('finds classes and their names and comment blocks', async() => {
      const classes = await getScannedClasses('class/class-names.js');
      assert.deepEqual(classes.map((c) => c.name), [
        'Declaration',
        'VarDeclaration',
        'Assignment',
        'Namespace.AlsoAssignment',
        'Declared.AnotherAssignment',
      ]);

      assert.deepEqual(await Promise.all(classes.map((c) => getTestProps(c))), [
        {
          name: 'Declaration',
          description: 'A simple declaration',
          privacy: 'public',
        },
        {
          description: 'The variable\'s name is used.',
          name: 'VarDeclaration',
          privacy: 'public',
        },
        {
          description: 'The left hand side of the assignment is used.',
          name: 'Assignment',
          privacy: 'public',
        },
        {
          description: 'Namespaced assignments work too',
          name: 'Namespace.AlsoAssignment',
          privacy: 'public',
        },
        {
          description: 'Declared namespace works too',
          name: 'Declared.AnotherAssignment',
          privacy: 'public',
        },
      ]);
    });

    test('finds methods', async() => {
      const classes = await getScannedClasses('class/class-methods.js');
      assert.deepEqual(await Promise.all(classes.map((c) => getTestProps(c))), [
        {
          name: 'Class',
          description: '',
          privacy: 'public',
          methods: [
            {
              name: 'customInstanceFunction',
              description: '',
            },
            {
              name: 'customInstanceFunctionWithJSDoc',
              description: 'This is the description for ' +
                  'customInstanceFunctionWithJSDoc.',
              return: {
                desc: 'The number 5, always.',
                type: 'Number',
              },
            },
            {
              name: 'customInstanceFunctionWithParams',
              description: '',
              params: [{name: 'a'}, {name: 'b'}, {name: 'c'}],
            },
            {
              name: 'customInstanceFunctionWithParamsAndJSDoc',
              description: 'This is the description for ' +
                  'customInstanceFunctionWithParamsAndJSDoc.',
              params: [
                {
                  name: 'a',
                  type: 'Number',
                  description: 'The first argument',
                },
                {
                  name: 'b',
                  type: 'Number',
                },
                {
                  name: 'c',
                  type: 'Number',
                  description: 'The third argument',
                }
              ],
              return: {
                desc: 'The number 7, always.',
                type: 'Number',
              },
            },
            {
              name: 'customInstanceFunctionWithParamsAndPrivateJSDoc',
              description: 'This is the description for\n' +
                  'customInstanceFunctionWithParamsAndPrivateJSDoc.',
            },
          ]
        },
      ]);
    });

    test('deals with super classes correctly', async() => {
      const classes = await getScannedClasses('class/super-class.js');

      assert.deepEqual(classes.map((f) => f.name), ['Base', 'Subclass']);
      assert.deepEqual(await Promise.all(classes.map((c) => getTestProps(c))), [
        {
          name: 'Base',
          description: '',
          privacy: 'public',
          methods: [
            {
              description: 'This is a base method.',
              name: 'baseMethod',
            },
            {
              description: 'Will be overriden by Subclass.',
              name: 'overriddenMethod',
            }
          ]
        },
        {
          name: 'Subclass',
          description: '',
          privacy: 'public',
          superClass: 'Base',
          methods: [
            {
              description: 'Overrides the method on Base.',
              name: 'overriddenMethod',
            },
            {
              description: 'This method only exists on Subclass.',
              name: 'subMethod',
            }
          ]
        }
      ]);
    });

    const testName =
        'does not produce duplicate classes for elements or mixins';
    test(testName, async() => {
      const scannedFeatures =
          await getScannedFeatures('class/more-specific-classes.js');

      // Ensures no duplicates
      assert.deepEqual(
          scannedFeatures.map((f) => f.name),
          ['Element', 'AnnotatedElement', 'Mixin', 'AnnotatedMixin']);

      // Ensures we get the more specific types
      // TODO(rictic): these should probably not be Polymer specific.
      assert.deepEqual(scannedFeatures.map((f) => f.constructor.name), [
        'ScannedPolymerElement',
        'ScannedPolymerElement',
        'ScannedPolymerElementMixin',
        'ScannedPolymerElementMixin'
      ]);
    });

  });

  suite('resolving', () => {
    test('finds classes and their names and descriptions', async() => {
      const classes = await getClasses('class/class-names.js');
      assert.deepEqual(classes.map((c) => c.name), [
        'Declaration',
        'VarDeclaration',
        'Assignment',
        'Namespace.AlsoAssignment',
        'Declared.AnotherAssignment',
      ]);

      assert.deepEqual(await Promise.all(classes.map((c) => getTestProps(c))), [
        {
          name: 'Declaration',
          description: 'A simple declaration',
          privacy: 'public',
        },
        {
          description: 'The variable\'s name is used.',
          name: 'VarDeclaration',
          privacy: 'public',
        },
        {
          description: 'The left hand side of the assignment is used.',
          name: 'Assignment',
          privacy: 'public',
        },
        {
          description: 'Namespaced assignments work too',
          name: 'Namespace.AlsoAssignment',
          privacy: 'public',
        },
        {
          description: 'Declared namespace works too',
          name: 'Declared.AnotherAssignment',
          privacy: 'public',
        },
      ]);
    });

    test('finds methods', async() => {
      const classes = await getClasses('class/class-methods.js');
      assert.deepEqual(await Promise.all(classes.map((c) => getTestProps(c))), [
        {
          name: 'Class',
          description: '',
          privacy: 'public',
          methods: [
            {
              name: 'customInstanceFunction',
              description: '',
            },
            {
              name: 'customInstanceFunctionWithJSDoc',
              description: 'This is the description for ' +
                  'customInstanceFunctionWithJSDoc.',
              return: {
                desc: 'The number 5, always.',
                type: 'Number',
              },
            },
            {
              name: 'customInstanceFunctionWithParams',
              description: '',
              params: [{name: 'a'}, {name: 'b'}, {name: 'c'}],

            },
            {
              name: 'customInstanceFunctionWithParamsAndJSDoc',
              description: 'This is the description for ' +
                  'customInstanceFunctionWithParamsAndJSDoc.',
              params: [
                {
                  name: 'a',
                  type: 'Number',
                  description: 'The first argument',
                },
                {
                  name: 'b',
                  type: 'Number',
                },
                {
                  name: 'c',
                  type: 'Number',
                  description: 'The third argument',
                }
              ],
              return: {
                desc: 'The number 7, always.',
                type: 'Number',
              },
            },
            {
              name: 'customInstanceFunctionWithParamsAndPrivateJSDoc',
              description: 'This is the description for\n' +
                  'customInstanceFunctionWithParamsAndPrivateJSDoc.',
            },
          ]
        },
      ]);
    });

    test('deals with super classes correctly', async() => {
      const classes = await getClasses('class/super-class.js');

      assert.deepEqual(classes.map((f) => f.name), ['Base', 'Subclass']);
      assert.deepEqual(await Promise.all(classes.map((c) => getTestProps(c))), [
        {
          name: 'Base',
          description: '',
          privacy: 'public',
          methods: [
            {
              description: 'This is a base method.',
              name: 'baseMethod',
            },
            {
              description: 'Will be overriden by Subclass.',
              name: 'overriddenMethod',
            }
          ]
        },
        {
          name: 'Subclass',
          description: '',
          privacy: 'public',
          superClass: 'Base',
          methods: [
            {
              description: 'This is a base method.',
              name: 'baseMethod',
              inheritedFrom: 'Base'
            },
            {
              description: 'Overrides the method on Base.',
              name: 'overriddenMethod',
            },
            {
              description: 'This method only exists on Subclass.',
              name: 'subMethod',
            },
          ]
        }
      ]);
    });

    const testName =
        'does not produce duplicate classes for elements or mixins';
    test(testName, async() => {
      const features = (await analyzer.analyze([
                         'class/more-specific-classes.js'
                       ])).getFeatures();
      const interestingFeatures = Array.from(features).filter(
          (f) => f instanceof Element || f instanceof ElementMixin ||
              f instanceof Class) as Array<Element|ElementMixin|Class>;

      // Ensures no duplicates
      assert.deepEqual(
          interestingFeatures.map((f) => f.name),
          ['Element', 'AnnotatedElement', 'Mixin', 'AnnotatedMixin']);

      // Ensures we get the more specific types
      // TODO(rictic): these should probably not be Polymer specific.
      assert.deepEqual(interestingFeatures.map((f) => f.constructor.name), [
        'PolymerElement',
        'PolymerElement',
        'PolymerElementMixin',
        'PolymerElementMixin'
      ]);
    });

  });
});
