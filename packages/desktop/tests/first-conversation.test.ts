import {expect, test} from 'bun:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {setupErrorMessage} from '../src/unified/setup-errors.js';
import {MessageEditor} from '../src/unified/MessageEditor.js';
import {Conversation} from '../src/Conversation.js';
import {readNavigation, writeNavigation} from '../src/unified/navigation.js';

test('a new assistant starts in conversation without overriding an explicit Today preference', () => {
  const project = crypto.randomUUID();
  expect(readNavigation(project, 'assistant')).toEqual({page: 'conversation', sessionId: ''});
  writeNavigation(project, 'assistant', {page: 'today', sessionId: ''});
  expect(readNavigation(project, 'assistant').page).toBe('today');
});

test('connection failures explain how to recover without encouraging an uncertain write retry', () => {
  expect(setupErrorMessage('Error: SETUP_PROVIDER_AUTH')).toContain('Enter a valid key');
  expect(setupErrorMessage('SETUP_PROVIDER_MODEL')).toContain('model ID');
  expect(setupErrorMessage('SETUP_PROVIDER_QUOTA')).toContain('quota');
  expect(setupErrorMessage('SETUP_PROVIDER_UNREACHABLE')).toContain('API URL');
  expect(setupErrorMessage('SETUP_PROVIDER_RESPONSE')).toContain('API format');
  expect(setupErrorMessage('SETUP_KEYCHAIN_WRITE_UNCONFIRMED')).toContain('reload the saved state before editing');
});

test('the first response has readable waiting and completion states', () => {
  const activity = {cursor: 1, order: ['r'], recovered: false, runs: {r: {text: '', prompt: 'Hello', status: 'running', truncated: false}}};
  const waiting = renderToStaticMarkup(createElement(Conversation, {activity}));
  expect(waiting).toContain('Waiting for the first response…');
  expect(waiting).toContain('role="status"');
  activity.runs.r.text = 'Hello back';
  expect(renderToStaticMarkup(createElement(Conversation, {activity}))).toContain('Responding…');
  activity.runs.r.status = 'completed';
  const completed = renderToStaticMarkup(createElement(Conversation, {activity}));
  expect(completed).toContain('Hello back');
  expect(completed).toContain('Response complete');
  expect(completed).not.toContain('Status: completed');
});

test('the editor distinguishes sending from responding and offers cancellation while running', () => {
  const props = {inputRef: null, value: 'Hello', placeholder: 'Message', disabled: false, sendDisabled: true, sending: true, running: false, cancelling: false, waiting: false, stored: true, onChange() {}, onSend() {}, onCancel() {}};
  const sending = renderToStaticMarkup(createElement(MessageEditor, props));
  expect(sending).toContain('Sending your message…');
  expect(sending).toContain('aria-label="Send message" disabled');
  const running = renderToStaticMarkup(createElement(MessageEditor, {...props, running: true}));
  expect(running).toContain('Zhivex is responding…');
  expect(running).toContain('aria-label="Cancel task"');
});
