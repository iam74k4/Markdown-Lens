import { expect } from '@playwright/test';

// Exercise the same disclosure paths as users; do not force-click hidden controls.
export async function revealTool(frame, selector) {
  const control = frame.locator(selector);
  if (await control.isVisible()) return control;
  await frame.locator('#more-tools').click();
  if (await control.evaluate(el => !!el.closest('#formatting'))) await frame.locator('#show-formatting').click();
  await expect(control).toBeVisible();
  return control;
}
export async function clickTool(frame, selector) {
  await (await revealTool(frame, selector)).click();
}
