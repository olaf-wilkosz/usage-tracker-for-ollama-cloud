// The "-" / "+" buttons around number fields (accessible replacement for the native spin buttons).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM(`<!doctype html><body>
  <div class="row"><label for="w">Warning (%)</label><input type="number" id="w" min="1" max="100" value="80"></div>
  <div class="row"><input type="number" id="c" min="0" step="1" value="3" aria-label="Low credits alert, days"></div>
</body>`);
globalThis.document = dom.window.document;
globalThis.Event = dom.window.Event;
const { enhanceNumberInputs } = await import('../extension/settings.js');

test('every number field gets a labelled "-" and "+", kept out of the Tab order', () => {
  enhanceNumberInputs();
  const wrappers = [...document.querySelectorAll('.stepper')];
  assert.equal(wrappers.length, 2);
  const [first] = wrappers;
  const buttons = [...first.querySelectorAll('button')];
  assert.deepEqual(buttons.map((b) => b.getAttribute('aria-label')), ['Decrease Warning (%)', 'Increase Warning (%)'], 'named after the field label');
  assert.deepEqual(buttons.map((b) => b.textContent), ['\u2212', '+']);
  assert.ok(buttons.every((b) => b.tabIndex === -1 && b.type === 'button'), 'the field keeps the keyboard; the buttons are for pointers');
  assert.equal(wrappers[1].querySelector('button').getAttribute('aria-label'), 'Decrease Low credits alert, days', 'aria-label wins over a label');
  assert.equal(first.querySelector('input').id, 'w', 'the same element, so existing references keep working');
});

test('the buttons step the value within min and max and report the change', () => {
  const input = document.getElementById('w');
  const [minus, plus] = input.parentElement.querySelectorAll('button');
  const seen = [];
  input.addEventListener('input', () => seen.push(['input', input.value]));
  input.addEventListener('change', () => seen.push(['change', input.value]));

  plus.click();
  assert.equal(input.value, '81');
  assert.deepEqual(seen, [['input', '81'], ['change', '81']]);
  minus.click(); minus.click();
  assert.equal(input.value, '79');

  input.value = '100';
  plus.click();
  assert.equal(input.value, '100', 'stops at max');
  input.value = '1';
  minus.click();
  assert.equal(input.value, '1', 'stops at min');

  input.value = '';
  plus.click(); // an empty field starts from the minimum
  assert.ok(Number(input.value) >= 1);
});

test('running it again does not wrap twice', () => {
  enhanceNumberInputs();
  assert.equal(document.querySelectorAll('.stepper').length, 2);
  assert.equal(document.querySelectorAll('.stepper .stepper').length, 0);
});
