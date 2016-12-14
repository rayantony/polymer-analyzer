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


import {CancelToken} from 'cancel-token';
import {assert} from 'chai';
import * as path from 'path';

import {Analyzer} from '../../analyzer';
import {Document} from '../../model/model';
import {FSUrlLoader} from '../../url-loader/fs-url-loader';
import {assertIsCancelled} from '../test-utils';

suite('cancelling analysis midway through', () => {
  test(`analyze() rejects with a Cancel`, async() => {
    const analyzer = new Analyzer(
        {urlLoader: new FSUrlLoader(path.join(__dirname, '..', 'static'))});
    const cancelSource = CancelToken.source();

    const resultPromise =
        analyzer.analyze('vanilla-elements.js', undefined, cancelSource.token);
    cancelSource.cancel();
    await assertIsCancelled(resultPromise);
  });

  test('we can handle parallel requests, one canceled one not ', async() => {
    const analyzer = new Analyzer(
        {urlLoader: new FSUrlLoader(path.join(__dirname, '..', 'static'))});
    const cancelSource = CancelToken.source();

    const resultPromise1 =
        analyzer.analyze('vanilla-elements.js', undefined, cancelSource.token);
    const resultPromise2 = analyzer.analyze('vanilla-elements.js', undefined);
    cancelSource.cancel();
    await assertIsCancelled(resultPromise1);
    assert.instanceOf(await resultPromise2, Document);
  });
});
