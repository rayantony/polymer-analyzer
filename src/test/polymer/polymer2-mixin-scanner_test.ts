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
import {PolymerElementMixin} from '../../index';
import {Visitor} from '../../javascript/estree-visitor';
import {JavaScriptParser} from '../../javascript/javascript-parser';
import {ScannedFeature} from '../../model/model';
import {ScannedPolymerElementMixin} from '../../polymer/polymer-element-mixin';
import {Polymer2MixinScanner} from '../../polymer/polymer2-mixin-scanner';
import {FSUrlLoader} from '../../url-loader/fs-url-loader';
import {CodeUnderliner} from '../test-utils';

suite('Polymer2MixinScanner', () => {
  const testFilesDir = path.resolve(__dirname, '../static/polymer2/');
  const urlLoader = new FSUrlLoader(testFilesDir);
  const underliner = new CodeUnderliner(urlLoader);
  const analyzer = new Analyzer({urlLoader});

  async function getScannedMixins(filename: string) {
    const file = await urlLoader.load(filename);
    const parser = new JavaScriptParser();
    const document = parser.parse(file, filename);
    const scanner = new Polymer2MixinScanner();
    const visit = (visitor: Visitor) =>
        Promise.resolve(document.visit([visitor]));

    const features: ScannedFeature[] = await scanner.scan(document, visit);
    return <ScannedPolymerElementMixin[]>features.filter(
        (e) => e instanceof ScannedPolymerElementMixin);
  };

  async function getMixins(filename: string) {
    const analysis = await analyzer.analyze([filename]);
    return Array.from(analysis.getFeatures({kind: 'polymer-element-mixin'}));
  };

  async function getTestProps(mixin: ScannedPolymerElementMixin|
                              PolymerElementMixin) {
    const properties = [];
    for (const {name} of mixin.properties) {
      properties.push({name});
    }
    const attributes = [];
    for (const {name} of mixin.attributes) {
      attributes.push({name});
    }
    const methods = [];
    for (const {name, params, return: r} of mixin.methods) {
      methods.push({name, params, return: r});
    }
    const {name, description, summary} = mixin;
    return {
      name,
      description,
      summary,
      properties,
      attributes,
      methods,
      underlinedWarnings: await underliner.underline(mixin.warnings)
    };
  }

  test('finds mixin function declarations', async() => {
    const mixins = await getScannedMixins('test-mixin-1.js');
    const mixinData = await Promise.all(mixins.map(getTestProps));
    assert.deepEqual(mixinData, [{
                       name: 'TestMixin',
                       description: 'A mixin description',
                       summary: 'A mixin summary',
                       properties: [{
                         name: 'foo',
                       }],
                       attributes: [{
                         name: 'foo',
                       }],
                       methods: [],
                       underlinedWarnings: []
                     }]);
    const underlinedSource = await underliner.underline(mixins[0].sourceRange);
    assert.equal(underlinedSource, `
function TestMixin(superclass) {
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  return class extends superclass {
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    static get properties() {
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
      return {
~~~~~~~~~~~~~~
        foo: {
~~~~~~~~~~~~~~
          notify: true,
~~~~~~~~~~~~~~~~~~~~~~~
          type: String,
~~~~~~~~~~~~~~~~~~~~~~~
        },
~~~~~~~~~~
      };
~~~~~~~~
    }
~~~~~
  }
~~~
}
~`);
  });

  test('finds mixin arrow function expressions', async() => {
    const mixins = await getScannedMixins('test-mixin-2.js');
    const mixinData = await Promise.all(mixins.map(getTestProps));
    assert.deepEqual(mixinData, [{
                       name: 'Polymer.TestMixin',
                       description: 'A mixin description',
                       summary: 'A mixin summary',
                       properties: [{
                         name: 'foo',
                       }],
                       attributes: [{
                         name: 'foo',
                       }],
                       methods: [],
                       underlinedWarnings: []
                     }]);
    const underlinedSource = await underliner.underline(mixins[0].sourceRange);
    assert.equal(underlinedSource, `
const TestMixin = (superclass) => class extends superclass {
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  static get properties() {
~~~~~~~~~~~~~~~~~~~~~~~~~~~
    return {
~~~~~~~~~~~~
      foo: {
~~~~~~~~~~~~
        notify: true,
~~~~~~~~~~~~~~~~~~~~~
        type: String,
~~~~~~~~~~~~~~~~~~~~~
      },
~~~~~~~~
    };
~~~~~~
  }
~~~
}
~`);
  });

  test('finds mixin function expressions', async() => {
    const mixins = await getScannedMixins('test-mixin-3.js');
    const mixinData = await Promise.all(mixins.map(getTestProps));
    assert.deepEqual(mixinData, [{
                       name: 'Polymer.TestMixin',
                       description: '',
                       summary: '',
                       properties: [{
                         name: 'foo',
                       }],
                       attributes: [{
                         name: 'foo',
                       }],
                       methods: [],
                       underlinedWarnings: [],
                     }]);
    const underlinedSource = await underliner.underline(mixins[0].sourceRange);
    assert.equal(underlinedSource, `
const TestMixin = function(superclass) {
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  return class extends superclass {
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    static get properties() {
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
      return {
~~~~~~~~~~~~~~
        foo: {
~~~~~~~~~~~~~~
          notify: true,
~~~~~~~~~~~~~~~~~~~~~~~
          type: String,
~~~~~~~~~~~~~~~~~~~~~~~
        },
~~~~~~~~~~
      };
~~~~~~~~
    }
~~~~~
  }
~~~
}
~`);
  });

  test(
      'finds mixin variable declaration with only name, does not use trailing function',
      async() => {
        const mixins = await getScannedMixins('test-mixin-4.js');
        const mixinData = await Promise.all(mixins.map(getTestProps));
        assert.deepEqual(mixinData, [{
                           name: 'Polymer.TestMixin',
                           description: '',
                           summary: '',
                           properties: [],
                           attributes: [],
                           methods: [],
                           underlinedWarnings: [],
                         }]);
        const underlinedSource =
            await underliner.underline(mixins[0].sourceRange);
        assert.equal(underlinedSource, `
let TestMixin;
~~~~~~~~~~~~~~`);
      });

  test('what to do on a class marked @polymerMixin?', async() => {
    const mixins = await getScannedMixins('test-mixin-5.js');
    const mixinData = mixins.map(getTestProps);
    assert.deepEqual(mixinData, []);
  });

  test('finds mixin function declaration with only name', async() => {
    const mixins = await getScannedMixins('test-mixin-6.js');
    const mixinData = await Promise.all(mixins.map(getTestProps));
    assert.deepEqual(mixinData, [{
                       name: 'Polymer.TestMixin',
                       description: '',
                       summary: '',
                       properties: [],
                       attributes: [],
                       methods: [],
                       underlinedWarnings: []
                     }]);
    const underlinedSource = await underliner.underline(mixins[0].sourceRange);
    assert.equal(underlinedSource, `
function TestMixin() {
~~~~~~~~~~~~~~~~~~~~~~
}
~`);
  });

  test('finds mixin assigned to a namespace', async() => {
    const mixins = await getScannedMixins('test-mixin-7.js');
    const mixinData = await Promise.all(mixins.map(getTestProps));
    assert.deepEqual(mixinData, [{
                       name: 'Polymer.TestMixin',
                       description: '',
                       summary: '',
                       properties: [{
                         name: 'foo',
                       }],
                       attributes: [{
                         name: 'foo',
                       }],
                       methods: [],
                       underlinedWarnings: [],
                     }]);
    const underlinedSource = await underliner.underline(mixins[0].sourceRange);
    assert.equal(underlinedSource, `
Polymer.TestMixin = Polymer.woohoo(function TestMixin(base) {
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  /** @polymerMixinClass */
~~~~~~~~~~~~~~~~~~~~~~~~~~~
  class TestMixin extends base {
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    static get properties() {
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
      return {
~~~~~~~~~~~~~~
        foo: {
~~~~~~~~~~~~~~
          notify: true,
~~~~~~~~~~~~~~~~~~~~~~~
          type: String,
~~~~~~~~~~~~~~~~~~~~~~~
        },
~~~~~~~~~~
      };
~~~~~~~~
    };
~~~~~~
  };
~~~~
  return TestMixin;
~~~~~~~~~~~~~~~~~~~
});
~~`);
  });

  test(
      'properly analyzes nested mixin assignments with memberof tags',
      async() => {
        const mixins = await getScannedMixins('test-mixin-8.js');
        const mixinData = await Promise.all(mixins.map(getTestProps));
        assert.deepEqual(mixinData, [{
                           name: 'Polymer.TestMixin',
                           description: '',
                           summary: '',
                           properties: [{
                             name: 'foo',
                           }],
                           attributes: [{
                             name: 'foo',
                           }],
                           methods: [],
                           underlinedWarnings: [],
                         }]);

      });

  test('properly analyzes mixin instance and class methods', async() => {
    const mixins = await getScannedMixins('test-mixin-9.js');
    const mixinData = await Promise.all(mixins.map(getTestProps));
    assert.deepEqual(mixinData, [
      {
        name: 'TestMixin',
        description: 'A mixin description',
        summary: 'A mixin summary',
        properties: [{
          name: 'foo',
        }],
        attributes: [{
          name: 'foo',
        }],
        methods: [
          {name: 'customInstanceFunction', params: [], return: undefined},
          {
            name: 'customInstanceFunctionWithJSDoc',
            params: [], return: {
              desc: 'The number 5, always.',
              type: 'Number',
            },
          },
          {
            name: 'customInstanceFunctionWithParams',
            params: [{name: 'a'}, {name: 'b'}, {name: 'c'}], return: undefined,
          },
          {
            name: 'customInstanceFunctionWithParamsAndJSDoc',
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
            params: [], return: undefined,
          },
        ],
        underlinedWarnings: [],
      }
    ]);

  });

  test('mixes mixins into mixins', async() => {
    const mixins = await getMixins('test-mixin-10.js');
    const mixinData = await Promise.all(mixins.map(getTestProps));
    assert.deepEqual(mixinData, [
      {
        name: 'Base',
        description: '',
        summary: '',
        attributes: [{name: 'foo'}],
        methods: [
          {name: 'baseMethod', params: [], return: undefined},
          {name: 'privateMethod', params: [], return: undefined},
          {name: 'privateOverriddenMethod', params: [], return: undefined},
          {name: 'overrideMethod', params: [], return: undefined},
        ],
        properties: [{name: 'foo'}],
        underlinedWarnings: [],
      },
      {
        name: 'Middle',
        attributes: [{name: 'foo'}],
        description: '',
        methods: [
          {name: 'baseMethod', params: [], return: undefined},
          {name: 'privateMethod', params: [], return: undefined},
          {name: 'privateOverriddenMethod', params: [], return: undefined},
          {name: 'overrideMethod', params: [], return: undefined},
          {name: 'middleMethod', params: [], return: undefined},
        ],
        properties: [{name: 'foo'}],
        summary: '',
        underlinedWarnings: [`
    privateOverriddenMethod() { }
    ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~`],
      }
    ]);
  });
});
