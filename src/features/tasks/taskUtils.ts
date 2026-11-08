import type { Task } from '../../domain/schemas';
import { today } from '../../lib/date';

/** 期限切れ → 今日 → 期限あり → 期限なし の順 */
export function sortTasks(tasks: Task[]): Task[] {
  return tasks.slice().sort((a, b) => {
    const da = a.dueDate ?? '9999-99-99';
    const db = b.dueDate ?? '9999-99-99';
    if (da !== db) return da < db ? -1 : 1;
    return a.createdAt < b.createdAt ? -1 : 1;
  });
}

export const isOverdue = (t: Task) => !t.done && !!t.dueDate && t.dueDate < today();
