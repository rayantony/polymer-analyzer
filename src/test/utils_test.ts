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

/// <reference path="../../node_modules/@types/mocha/index.d.ts" />

import {assert, use} from 'chai';
import {Deferred, parseUrl} from '../utils';

import chaiAsPromised = require('chai-as-promised');
use(chaiAsPromised);

suite('parseUrl', () => {

  function testUrl(url: string, properties: {[s: string]: any}) {
    const urlObject = parseUrl(url);
    for (const key in properties) {
      if (!properties.hasOwnProperty(key)) {
        continue;
      }
      assert.equal(urlObject[key], properties[key], `${url} property ${key}`);
    }
  }

  test('parses urls that are absolute paths', () => {
    testUrl(
        '/abs/path', {protocol: null, hostname: null, pathname: '/abs/path'});
    testUrl('/abs/path?query=string#hash', {
      protocol: null,
      hostname: null,
      pathname: '/abs/path',
      hash: '#hash',
      search: '?query=string',
    });
  });

  test('parses urls without protocol', () => {
    testUrl('//host/path', {
      protocol: undefined,
      hostname: 'host',
      pathname: '/path',
    });
    testUrl('//host', {
      protocol: undefined,
      hostname: 'host',
      pathname: null,
    });
  });

  test('parses urls that have protocols', () => {
    testUrl('https://host/path', {
      protocol: 'https:',
      hostname: 'host',
      pathname: '/path',
    });
  });
});

suite('Deferred', () => {

  test('resolves', async() => {
    const deferred = new Deferred<string>();
    const done = assert.becomes(deferred.promise, 'foo');
    deferred.resolve('foo');
    await done;
  });

  test('rejects', async() => {
    const deferred = new Deferred<string>();
    const done = assert.isRejected(deferred.promise, 'foo');
    deferred.reject(new Error('foo'));
    await done;
  });

  test('resolves only once', async() => {
    const deferred = new Deferred<string>();
    deferred.resolve('foo');
    try {
      deferred.resolve('bar');
      assert.fail();
    } catch (e) {
      // pass
    }
    try {
      deferred.reject(new Error('bar'));
      assert.fail();
    } catch (e) {
      // pass
    }
  });

  test('rejects', async() => {
    const deferred = new Deferred<string>();
    deferred.reject(new Error('foo'));
    deferred.promise.catch((_) => {});
    try {
      deferred.resolve('bar');
      assert.fail();
    } catch (e) {
      // pass
    }
    try {
      deferred.reject(new Error('bar'));
      assert.fail();
    } catch (e) {
      // pass
    }
  });

});
