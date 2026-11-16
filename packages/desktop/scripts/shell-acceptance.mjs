import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

/** Called by the installed-core fixture after registering Assistant and two real Git projects. */
export async function verifyShell(page, desktop, directory, coordinator) {
  const button = name => page.getByRole('button', {name, exact: true});
  const go = async name => {await page.locator('nav[aria-label="Main"]').getByRole('button', {name, exact: true}).click(); await page.waitForFunction(label => document.querySelector('.toolbar strong')?.textContent === label, name);};
  const chooseProject = async name => {
    await button('Code projects').click();
    await page.getByRole('heading', {name: 'Your Code projects'}).waitFor();
    await page.locator('.agent-list .row').filter({has: page.getByText(name, {exact: true})}).getByRole('button').click();
    await page.getByRole('heading', {name: 'Your Code projects'}).waitFor({state: 'hidden'});
  };
  await desktop.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 960));
  await go('Workspace');
  const originalSession = await page.locator('.session-list .selected').getAttribute('data-session-id');
  const selectOriginal = () => page.locator(`[data-session-id="${originalSession}"]`).click();
  await button('Assistant settings').click(); await selectOriginal();
  await page.getByRole('region', {name: 'Assistant settings'}).waitFor({state: 'hidden'});
  assert.equal(await page.locator('.toolbar strong').textContent(), 'Workspace');
  await button('Code projects').click(); await selectOriginal();
  await page.getByRole('heading', {name: 'Your Code projects'}).waitFor({state: 'hidden'});
  await button('Assistant settings').click(); await page.keyboard.press('Meta+n');
  await page.getByRole('region', {name: 'Assistant settings'}).waitFor({state: 'hidden'});
  await page.waitForFunction(id => document.querySelector('.session-list .selected')?.getAttribute('data-session-id') !== id, originalSession);
  await selectOriginal();
  await button('Rename conversation').click();
  await page.getByLabel('Conversation title',{exact:true}).fill('Reviewed Project A');
  await button('Save title').click();
  await page.getByRole('dialog',{name:'Rename conversation'}).waitFor({state:'hidden'});
  await page.getByRole('heading',{name:'Reviewed Project A',exact:true}).waitFor();
  await page.reload(); await button('Code').click(); await page.getByRole('heading',{name:'Reviewed Project A',exact:true}).waitFor();
  await go('Decision history');
  await desktop.evaluate(({session}, filename) => {session.defaultSession.once('will-download', (_event, item) => item.setSavePath(filename));}, directory+'/decision-export.json');
  await button('Export this decision page').click();
  let exported;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { exported = JSON.parse(await readFile(directory+'/decision-export.json','utf8')); break; } catch {await new Promise(resolve => setTimeout(resolve,100));}
  }
  assert.equal(exported?.scope,'decision-page'); assert.equal(exported?.sessionId,originalSession); assert(exported.decisions.length > 0);
  await go('Workspace');
  await page.getByLabel('Message', {exact: true}).fill('Draft scoped to project A');
  const code = ['Changes', 'Worktrees', 'Checkpoints', 'Execution', 'Context', 'Git delivery', 'Decision history', 'Workspace'];
  for (const destination of code) await go(destination);
  assert.equal(await page.getByLabel('Message', {exact: true}).inputValue(), 'Draft scoped to project A');
  await go('Context');
  await chooseProject('b'); await go('Workspace');
  assert.notEqual(await page.getByLabel('Message', {exact: true}).inputValue(), 'Draft scoped to project A');
  await page.getByLabel('Message', {exact: true}).fill('Draft scoped to project B');
  await chooseProject('a');
  await page.waitForFunction(() => document.querySelector('.toolbar strong')?.textContent === 'Context');
  await go('Workspace');
  assert.equal(await page.getByLabel('Message', {exact: true}).inputValue(), 'Draft scoped to project A');
  await button('Assistant').click();
  const assistant = ['Today', 'Conversations', 'Agenda', 'Tasks & reminders', 'Automations', 'Notes', 'Review actions', 'Decision history'];
  for (const destination of assistant) await go(destination);
  await go('Conversations');
  await page.getByLabel('Message', {exact: true}).fill('Personal draft remains personal');
  await button('Code').click(); await go('Workspace');
  assert.equal(await page.getByLabel('Message', {exact: true}).inputValue(), 'Draft scoped to project A');
  await button('Assistant').click();
  assert.equal(await page.getByLabel('Message', {exact: true}).inputValue(), 'Personal draft remains personal');
  await page.reload();
  await page.getByLabel('Message', {exact: true}).waitFor();
  await page.waitForFunction(() => document.querySelector('#prompt')?.value === 'Personal draft remains personal');
  const original = await page.evaluate(() => window.zhivex.setupState());
  await coordinator.call('management', {resource: 'agents', action: 'create', args: ['Second personal agent']});
  await coordinator.call('management', {resource: 'connections', action: 'use', args: [original.connections[0].id]});
  await coordinator.call('management', {resource: 'agents', action: 'start', args: []});
  await page.reload();
  await page.getByRole('region', {name: 'Today overview'}).waitFor();
  assert.equal(await page.getByLabel('Message', {exact: true}).inputValue(), '');
  await page.getByLabel('Message', {exact: true}).fill('Second agent private draft');
  await go('Notes');
  const chooseAgent = async name => {
    await button('Assistant settings').click();
    await page.locator('.agent-list .row').filter({has: page.getByText(name, {exact: true})}).getByRole('button', {name: 'Use assistant'}).click();
    await page.getByRole('region', {name: 'Assistant settings'}).waitFor({state: 'hidden'});
  };
  await chooseAgent('Personal');
  await page.waitForFunction(() => document.querySelector('#prompt')?.value === 'Personal draft remains personal');
  await chooseAgent('Second personal agent');
  await page.waitForFunction(() => document.querySelector('.toolbar strong')?.textContent === 'Notes');
  await go('Today');
  assert.equal(await page.getByLabel('Message', {exact: true}).inputValue(), 'Second agent private draft');
  await chooseAgent('Personal');
  await button('Assistant settings').click();
  assert.equal(await page.locator('.toolbar strong').textContent(), 'Assistant settings');
  await page.keyboard.press('Escape');
  await page.getByRole('region', {name: 'Assistant settings'}).waitFor({state: 'hidden'});
  await go('Today');
  await page.emulateMedia({reducedMotion: 'reduce'});
  assert(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches));
  assert(await page.evaluate(async () => {const fonts = await Promise.all([document.fonts.load('13px Geist'), document.fonts.load('12px Mono')]); return fonts.every(faces => faces.length > 0 && faces.every(face => face.status === 'loaded')); }));
  for (const appearance of ['dark', 'light']) {
    await button(appearance === 'dark' ? 'Dark appearance' : 'Light appearance').click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), appearance);
    for (const width of [1440, 1280, 390]) {
      await desktop.evaluate(({BrowserWindow}, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, width === 1280 ? 720 : width === 390 ? 844 : 960), width);
      // macOS caps native window height at the display work area. Pin the CSS viewport for reproducible proposal comparison.
      await page.setViewportSize({width, height: width === 1280 ? 720 : width === 390 ? 844 : 960});
      await page.waitForFunction(width => innerWidth === width && innerHeight === (width === 1280 ? 720 : width === 390 ? 844 : 960) && Math.round(document.querySelector('.unified-shell').getBoundingClientRect().height) === innerHeight, width);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (width === 390) {
        await button('Toggle navigation').click();
        await button('Assistant settings').click();
        assert.equal(await page.locator('main').getAttribute('inert'), null);
        assert(await page.locator('main').evaluate(node => node === document.activeElement));
        await page.keyboard.press('Escape');
        await button('Toggle navigation').click();
        await page.keyboard.press('Shift+Tab');
        assert(await page.locator('.sidebar').evaluate(node => node.contains(document.activeElement)));
        await page.keyboard.press('Escape');
        assert(await button('Toggle navigation').evaluate(node => node === document.activeElement));
      }
      await button('Search pages and conversations').click();
      const dialog = page.getByRole('dialog', {name: 'Go to…'});
      await dialog.waitFor();
      const countConversations = () => page.evaluate(async () => {const hosts = await window.zhivex.hosts(); const host = hosts.find(value => value.area === 'assistant'); const result = await window.zhivex.command(host.id,{method:'session.list'}); return result.data.sessions.length;});
      const count = await countConversations();
      await page.keyboard.press('Meta+n');
      await new Promise(resolve => setTimeout(resolve,200));
      assert.equal(await countConversations(),count,'Modal shortcuts must not create background conversations');
      const bounds = await dialog.boundingBox(); await page.mouse.click(bounds.x + 1, bounds.y + 1);
      assert(await dialog.isVisible(),'Clicking the dialog border must not dismiss it');
      await page.getByRole('textbox',{name:'Search pages and conversations'}).focus();
      for (let i = 0; i < 20; i++) {await page.keyboard.press('Tab'); assert(await dialog.evaluate(node => node.contains(document.activeElement)));}
      await page.keyboard.press('Escape');
      assert(await button('Search pages and conversations').evaluate(node => node === document.activeElement));
      assert(await page.locator('body').evaluate(node => [...node.querySelectorAll('*')].every(element => getComputedStyle(element).animationName === 'none')));
      await page.screenshot({path: `${directory}/shell-${appearance}-${width}.png`});
    }
    await desktop.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 960));
    await page.setViewportSize({width:1440,height:960});
  }
  return {passed: true, codeDestinations: code, assistantDestinations: assistant, checks: ['shared settings and accurate breadcrumbs', 'recent/new conversation dismisses settings and projects', 'modal shortcuts cannot mutate background conversations', 'dialog border does not dismiss content', 'downloaded JSON matches the displayed decision page', 'conversation rename persists through core and reload', 'draft and navigation isolated across two projects and two personal agents', 'reload preserves personal selection and draft', 'light/dark at 1440x960, 1280x720, 390x844', 'native dialog focus trap and Escape restore', 'compact settings dismiss drawer and focus content', 'reduced motion', 'bundled fonts'], limitations: ['Local installed core and explicit synthetic provider/credentials; no keychain or live accounts']};
}
