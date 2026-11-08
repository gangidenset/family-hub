// ドメインモデル: すべての共有エンティティのスキーマを一元定義する。
// UI 入力・同期受信・バックアップ復元のすべてがこのスキーマで検証される (docs/07-security.md S-4, S-5)。
import { z } from 'zod';

// 制御文字 (改行・タブ以外) を禁止
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
// eslint-disable-next-line no-control-regex
const CONTROL_OR_NEWLINE = /[\u0000-\u001F\u007F]/;

export const LIMITS = {
  name: 50,
  title: 200,
  itemName: 100,
  note: 2000,
  memoBody: 20000,
  unit: 10,
  location: 200,
  quantityMax: 9999,
  memberIds: 30,
} as const;

/** 1 行テキスト (改行不可) */
export const line = (max: number, min = 0) =>
  z.string().min(min).max(max).refine((s) => !CONTROL_OR_NEWLINE.test(s), '使用できない文字が含まれています');
/** 複数行テキスト */
export const multiline = (max: number) =>
  z.string().max(max).refine((s) => !CONTROL.test(s), '使用できない文字が含まれています');

export const idSchema = z.uuid();
export const dateTimeSchema = z.iso.datetime(); // UTC (Z) のみ
export const dateSchema = z.iso.date(); // YYYY-MM-DD
/** HLC: <13桁ms>-<4桁16進カウンタ>-<deviceId> */
export const hlcSchema = z.string().regex(/^\d{13}-[0-9a-f]{4}-[0-9a-f-]{36}$/);
export const sortKeySchema = z.string().regex(/^[0-9a-z]{1,64}$/);

export const COLORS = ['teal', 'blue', 'indigo', 'purple', 'pink', 'red', 'orange', 'amber', 'green', 'gray'] as const;
export const colorSchema = z.enum(COLORS);
export type Color = (typeof COLORS)[number];

export const CATEGORY_SCOPES = ['shopping', 'memo', 'event', 'task'] as const;
export type CategoryScope = (typeof CATEGORY_SCOPES)[number];

const common = {
  groupId: idSchema,
  createdAt: dateTimeSchema,
  createdBy: idSchema,
  updatedAt: dateTimeSchema,
  updatedBy: idSchema,
  deleted: z.boolean(),
};

const nullableId = idSchema.nullable();

/** テーブルごとの固有フィールド */
const fieldShapes = {
  groups: {
    name: line(LIMITS.name, 1),
  },
  members: {
    name: line(LIMITS.name, 1),
    color: colorSchema,
    role: z.enum(['adult', 'child']),
  },
  devices: {
    name: line(LIMITS.name, 1),
    memberId: idSchema,
    revoked: z.boolean(),
  },
  categories: {
    scope: z.enum(CATEGORY_SCOPES),
    name: line(LIMITS.name, 1),
    color: colorSchema,
    sortKey: sortKeySchema,
  },
  shoppingLists: {
    name: line(LIMITS.name, 1),
    sortKey: sortKeySchema,
  },
  shoppingItems: {
    listId: idSchema,
    name: line(LIMITS.itemName, 1),
    quantity: z.number().int().min(1).max(LIMITS.quantityMax),
    unit: line(LIMITS.unit),
    categoryId: nullableId,
    note: line(LIMITS.title),
    checked: z.boolean(),
    checkedAt: dateTimeSchema.nullable(),
    checkedBy: nullableId,
    sortKey: sortKeySchema,
  },
  purchases: {
    listId: idSchema,
    itemId: idSchema,
    name: line(LIMITS.itemName, 1),
    quantity: z.number().int().min(1).max(LIMITS.quantityMax),
    unit: line(LIMITS.unit),
    categoryId: nullableId,
    purchasedAt: dateTimeSchema,
    purchasedBy: idSchema,
  },
  memos: {
    title: line(LIMITS.title),
    body: multiline(LIMITS.memoBody),
    categoryId: nullableId,
    pinned: z.boolean(),
  },
  events: {
    title: line(LIMITS.title, 1),
    allDay: z.boolean(),
    /** 終日: YYYY-MM-DD / 時刻指定: ISO UTC */
    start: z.union([dateSchema, dateTimeSchema]),
    end: z.union([dateSchema, dateTimeSchema]),
    /** 端末ローカル日付 (検索・表示用) */
    startDate: dateSchema,
    endDate: dateSchema,
    memberIds: z.array(idSchema).max(LIMITS.memberIds),
    categoryId: nullableId,
    location: line(LIMITS.location),
    note: multiline(LIMITS.note),
  },
  tasks: {
    title: line(LIMITS.title, 1),
    assigneeId: nullableId,
    dueDate: dateSchema.nullable(),
    done: z.boolean(),
    doneAt: dateTimeSchema.nullable(),
    doneBy: nullableId,
    categoryId: nullableId,
    note: multiline(LIMITS.note),
  },
} as const;

export type SharedTable = keyof typeof fieldShapes;
export const SHARED_TABLES = Object.keys(fieldShapes) as SharedTable[];
export const sharedTableSchema = z.enum(SHARED_TABLES as [SharedTable, ...SharedTable[]]);

function buildRecordSchema<T extends SharedTable>(t: T) {
  return z.strictObject({
    id: idSchema,
    ...common,
    ...fieldShapes[t],
    clock: z.record(z.string().regex(/^[a-zA-Z]{1,40}$/), hlcSchema),
  });
}
function buildPatchSchema<T extends SharedTable>(t: T) {
  return z.strictObject({ ...common, ...fieldShapes[t] }).partial();
}

export const recordSchemas = {
  groups: buildRecordSchema('groups'),
  members: buildRecordSchema('members'),
  devices: buildRecordSchema('devices'),
  categories: buildRecordSchema('categories'),
  shoppingLists: buildRecordSchema('shoppingLists'),
  shoppingItems: buildRecordSchema('shoppingItems'),
  purchases: buildRecordSchema('purchases'),
  memos: buildRecordSchema('memos'),
  events: buildRecordSchema('events'),
  tasks: buildRecordSchema('tasks'),
} satisfies Record<SharedTable, z.ZodType>;

export const patchSchemas = {
  groups: buildPatchSchema('groups'),
  members: buildPatchSchema('members'),
  devices: buildPatchSchema('devices'),
  categories: buildPatchSchema('categories'),
  shoppingLists: buildPatchSchema('shoppingLists'),
  shoppingItems: buildPatchSchema('shoppingItems'),
  purchases: buildPatchSchema('purchases'),
  memos: buildPatchSchema('memos'),
  events: buildPatchSchema('events'),
  tasks: buildPatchSchema('tasks'),
} satisfies Record<SharedTable, z.ZodType>;

export type Group = z.infer<typeof recordSchemas.groups>;
export type Member = z.infer<typeof recordSchemas.members>;
export type Device = z.infer<typeof recordSchemas.devices>;
export type Category = z.infer<typeof recordSchemas.categories>;
export type ShoppingList = z.infer<typeof recordSchemas.shoppingLists>;
export type ShoppingItem = z.infer<typeof recordSchemas.shoppingItems>;
export type Purchase = z.infer<typeof recordSchemas.purchases>;
export type Memo = z.infer<typeof recordSchemas.memos>;
export type CalendarEvent = z.infer<typeof recordSchemas.events>;
export type Task = z.infer<typeof recordSchemas.tasks>;

export interface RecordMap {
  groups: Group;
  members: Member;
  devices: Device;
  categories: Category;
  shoppingLists: ShoppingList;
  shoppingItems: ShoppingItem;
  purchases: Purchase;
  memos: Memo;
  events: CalendarEvent;
  tasks: Task;
}
export type AnyRecord = RecordMap[SharedTable];
/** 書き込み可能なフィールド (共通メタデータ・clock・id を除く) */
export type Fields<T extends SharedTable> = Omit<RecordMap[T], 'id' | 'clock' | keyof typeof common>;

/** 同時編集時に「負けた側の値」を保存するフィールド (docs/04-data-model.md §6) */
export const CONFLICT_FIELDS: Partial<Record<SharedTable, readonly string[]>> = {
  memos: ['title', 'body'],
};

/** 操作ログ 1 件 */
export const opSchema = z.strictObject({
  groupId: idSchema,
  deviceId: idSchema,
  seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  hlc: hlcSchema,
  table: sharedTableSchema,
  recordId: idSchema,
  patch: z.record(z.string().max(40), z.unknown()),
  base: z.record(z.string().max(40), hlcSchema.nullable()).optional(),
});
export type Op = z.infer<typeof opSchema>;

/** パッチ内容まで含めて操作を検証する */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function validateOp(raw: unknown): Op {
  // プロトタイプ汚染対策: zod の record 変換前に危険なキーを拒否
  const rawPatch = (raw as { patch?: unknown } | null)?.patch;
  if (rawPatch && typeof rawPatch === 'object' && Object.keys(rawPatch).some((k) => FORBIDDEN_KEYS.has(k))) {
    throw new Error('forbidden key');
  }
  const op = opSchema.parse(raw);
  const patch = patchSchemas[op.table].parse(op.patch);
  if (patch.groupId !== undefined && patch.groupId !== op.groupId) throw new Error('groupId mismatch');
  // 空パッチ (後続の操作で上書きされ圧縮されたもの) も有効
  return { ...op, patch };
}
