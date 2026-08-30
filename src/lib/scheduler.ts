export const BOX_INTERVALS_IN_DAYS = [0, 1, 3, 7, 14, 30];
export const MAX_BOX = BOX_INTERVALS_IN_DAYS.length - 1;

const DAY_IN_MS = 24 * 60 * 60 * 1000;

export interface ScheduledReview {
  box: number;
  intervalDays: number;
  dueAt: Date;
}

export function nextReview(box: number, isCorrect: boolean, now: Date): ScheduledReview {
  const currentBox = Number.isInteger(box) && box > 0 ? Math.min(box, MAX_BOX) : 0;
  const nextBox = isCorrect ? Math.min(currentBox + 1, MAX_BOX) : 0;
  const intervalDays = BOX_INTERVALS_IN_DAYS[nextBox] ?? 0;

  return {
    box: nextBox,
    intervalDays,
    dueAt: new Date(now.getTime() + intervalDays * DAY_IN_MS),
  };
}
