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

import {isCancel} from 'cancel-token';
import {assert} from 'chai';

export class UnexpectedResolutionError extends Error {
  resolvedValue: any;
  constructor(message: string, resolvedValue: any) {
    super(message);
    this.resolvedValue = resolvedValue;
  }
}

export async function invertPromise(promise: Promise<any>): Promise<any> {
  let value: any;
  try {
    value = await promise;
  } catch (e) {
    return e;
  }
  throw new UnexpectedResolutionError('Inverted Promise resolved', value);
}

export async function assertIsCancelled(promise: Promise<any>): Promise<void> {
  const rejection = await invertPromise(promise);
  assert.isTrue(isCancel(rejection), `Expected ${rejection} to be a Cancel.`);
}
