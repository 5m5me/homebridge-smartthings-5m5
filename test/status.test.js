import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attr, attrUnit, toCelsius } from '../src/core/status.js';

const status = {
  components: {
    main: { temperatureMeasurement: { temperature: { value: 70, unit: 'F' } }, x: { y: { value: null } } },
  },
};

test('attr returns value', () => {
  assert.equal(attr(status, 'main', 'temperatureMeasurement', 'temperature'), 70);
});

test('attr returns undefined when any level is missing', () => {
  assert.equal(attr(undefined, 'main', 'a', 'b'), undefined);
  assert.equal(attr({}, 'main', 'a', 'b'), undefined);
  assert.equal(attr(status, 'nope', 'a', 'b'), undefined);
  assert.equal(attr(status, 'main', 'nope', 'b'), undefined);
  assert.equal(attr(status, 'main', 'x', 'nope'), undefined);
});

test('attr passes null values through', () => {
  assert.equal(attr(status, 'main', 'x', 'y'), null);
});

test('attrUnit returns unit or undefined', () => {
  assert.equal(attrUnit(status, 'main', 'temperatureMeasurement', 'temperature'), 'F');
  assert.equal(attrUnit(status, 'main', 'x', 'y'), undefined);
  assert.equal(attrUnit({}, 'main', 'x', 'y'), undefined);
});

test('toCelsius', () => {
  assert.equal(toCelsius(25.1, 'C'), 25.1);
  assert.equal(toCelsius(25.1, undefined), 25.1);
  assert.equal(toCelsius(77, 'F'), 25);
  assert.equal(toCelsius(70, 'F'), 21.1);
  assert.equal(toCelsius(null, 'F'), null);
  assert.equal(toCelsius(undefined, 'C'), null);
});
