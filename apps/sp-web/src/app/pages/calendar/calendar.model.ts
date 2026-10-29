/** Local calendar maths for the Calendar page. Days are YYYY-MM-DD strings. */

export interface CalendarDay {
  key: string;
  day: number;
  /** In the month being shown (the grid also pads with the months around it). */
  inMonth: boolean;
  isToday: boolean;
}

export function dayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function addMonths(date: Date, months: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
}

/** The first and last day of the month, for the API. */
export function monthRange(month: Date): { from: string; to: string } {
  const first = startOfMonth(month);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  return { from: dayKey(first), to: dayKey(last) };
}

/** Weeks Sunday to Saturday covering the whole month. */
export function monthGrid(month: Date, today: Date = new Date()): CalendarDay[][] {
  const first = startOfMonth(month);
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - first.getDay());
  const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const weekCount = Math.ceil((first.getDay() + daysInMonth) / 7);
  const todayKey = dayKey(today);
  const weeks: CalendarDay[][] = [];
  for (let week = 0; week < weekCount; week += 1) {
    const days: CalendarDay[] = [];
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const date = new Date(
        start.getFullYear(),
        start.getMonth(),
        start.getDate() + week * 7 + weekday,
      );
      const key = dayKey(date);
      days.push({
        key,
        day: date.getDate(),
        inMonth: date.getMonth() === first.getMonth(),
        isToday: key === todayKey,
      });
    }
    weeks.push(days);
  }
  return weeks;
}

/** "Saturday, November 14" for a day key, in the reader's language. */
export function longDayLabel(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

export function monthLabel(month: Date): string {
  return month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}
