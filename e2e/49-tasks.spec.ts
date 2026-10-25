import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('tasks: add a task for myself, see it on the overview, tick it off', async ({ page }) => {
  await signIn(page);
  await page.goto('/aufgaben');
  const form = page.getByRole('form', { name: 'Neue Aufgabe' });
  await form.getByLabel('Aufgabe').fill('Hallenzeiten für 2027 beantragen');
  await form.getByRole('button', { name: 'Aufgabe anlegen' }).click();
  await expect(page.getByRole('list', { name: 'Aufgaben' })).toContainText('Hallenzeiten für 2027 beantragen');
  await page.goto('/');
  const mine = page.getByRole('list', { name: 'Deine Aufgaben' });
  await mine.getByRole('checkbox', { name: 'Hallenzeiten für 2027 beantragen erledigt' }).click();
  // Done tasks leave "Deine Aufgaben" and show under "Erledigt".
  await expect(mine).toHaveCount(0);
  await page.goto('/aufgaben');
  await page.getByRole('group', { name: 'Ansicht' }).getByRole('button', { name: 'Erledigt' }).click();
  await expect(page.getByRole('checkbox', { name: 'Hallenzeiten für 2027 beantragen erledigt' })).toBeChecked();
});
