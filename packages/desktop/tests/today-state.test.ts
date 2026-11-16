import {expect, test} from 'bun:test';
import {agendaOverlaps, localAgendaDate, shiftAgendaDate} from '../src/unified/today-state.js';

test('agenda dates follow the selected zone across midnight and DST', () => {
  expect(localAgendaDate('America/Argentina/Buenos_Aires', new Date('2026-11-14T01:00:00Z'))).toBe('2026-11-13');
  expect(shiftAgendaDate('2026-03-08', 1)).toBe('2026-03-09');
  expect(shiftAgendaDate('2026-11-01', -1)).toBe('2026-10-31');
  expect(shiftAgendaDate('2028-02-28', 1)).toBe('2028-02-29');
  expect(() => shiftAgendaDate('2026-02-30', 1)).toThrow('Invalid date');
});
test('overlap marks busy timed events, excluding boundaries, free and cancelled events', () => {
  const event = (id: string, from: number, to: number) => ({id, summary: id, start: {dateTime: `2026-11-14T${from}:00:00Z`}, end: {dateTime: `2026-11-14T${to}:00:00Z`}});
  expect([...agendaOverlaps([event('a', 10, 12), event('b', 11, 13), event('boundary', 13, 14), {...event('free', 10, 14), busy: false}, {...event('cancelled', 10, 14), status: 'cancelled'}, {id: 'all-day', summary: '', start: {date: '2026-11-14'}, end: {date: '2026-11-15'}}])].sort()).toEqual(['a', 'b']);
});
