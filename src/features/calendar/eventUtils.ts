import type { CalendarEvent } from '../../domain/schemas';
import { isoToLocalTime } from '../../lib/date';

/** その日に重なる予定 (複数日予定を含む) */
export function eventsOn(events: CalendarEvent[], date: string): CalendarEvent[] {
  return events.filter((e) => e.startDate <= date && date <= e.endDate).sort(compareEvents);
}

export function compareEvents(a: CalendarEvent, b: CalendarEvent): number {
  if (a.startDate !== b.startDate) return a.startDate < b.startDate ? -1 : 1;
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
  return a.start < b.start ? -1 : 1;
}

export function timeLabel(e: CalendarEvent, date?: string): string {
  if (e.allDay) return '終日';
  if (date && e.startDate < date) return '〜' + (e.endDate === date ? isoToLocalTime(e.end) : '');
  return isoToLocalTime(e.start);
}
