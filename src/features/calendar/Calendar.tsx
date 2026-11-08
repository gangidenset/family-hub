import { useMemo, useState } from 'react';
import { useApp } from '../../app/context';
import { useActive, useCategories, useMemberMap, useMembers } from '../../app/hooks';
import { navigate, useRoute } from '../../app/router';
import { MainHeader } from '../../app/Shell';
import { Icon } from '../../components/Icon';
import { Avatar, colorVar, EmptyState, errorMessage, Fab, Field, MemberPicker, Sheet, Switch, useFeedback } from '../../components/ui';
import { LIMITS, type CalendarEvent } from '../../domain/schemas';
import { create, restoreDeleted, softDelete, update } from '../../db/repo';
import { formatDate, isoToLocalDate, isoToLocalTime, localToIso, monthGrid, parseLocalDate, today, weekdayLabels } from '../../lib/date';
import { eventsOn, timeLabel } from './eventUtils';

export function Calendar() {
  const { query } = useRoute();
  const events = useActive('events');
  const categories = useCategories('event');
  const members = useMemberMap();
  const selected = /^\d{4}-\d{2}-\d{2}$/.test(query.get('date') ?? '') ? query.get('date')! : today();
  const sel = parseLocalDate(selected);
  const [editing, setEditing] = useState<CalendarEvent | 'new' | null>(null);
  const grid = useMemo(() => monthGrid(sel.getFullYear(), sel.getMonth()), [sel.getFullYear(), sel.getMonth()]);
  const catMap = new Map(categories.map((c) => [c.id, c]));
  const t = today();

  const select = (d: string) => navigate(`/calendar?date=${d}`, { replace: true });
  const shiftMonth = (n: number) => {
    const d = new Date(sel.getFullYear(), sel.getMonth() + n, 1);
    select(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`);
  };
  const dayEvents = eventsOn(events ?? [], selected);

  return (
    <>
      <MainHeader title="家族の予定" />
      <main className="main">
        <div className="cal-head">
          <button className="icon-btn" aria-label="前の月" onClick={() => shiftMonth(-1)}>
            <Icon name="back" />
          </button>
          <h2>
            {sel.getFullYear()}年{sel.getMonth() + 1}月
          </h2>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            {selected !== t && (
              <button className="btn small ghost" onClick={() => select(t)}>
                今日
              </button>
            )}
            <button className="icon-btn" aria-label="次の月" onClick={() => shiftMonth(1)}>
              <Icon name="chevron" />
            </button>
          </div>
        </div>
        <div className="cal" role="grid" aria-label="カレンダー">
          {weekdayLabels.map((w, i) => (
            <div key={w} className={`wd ${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}`}>
              {w}
            </div>
          ))}
          {grid.map((d, i) => {
            const de = eventsOn(events ?? [], d);
            const date = parseLocalDate(d);
            return (
              <button
                key={d}
                className={`day ${date.getMonth() !== sel.getMonth() ? 'out' : ''} ${d === t ? 'today' : ''} ${i % 7 === 0 ? 'sun' : i % 7 === 6 ? 'sat' : ''}`}
                aria-pressed={d === selected}
                aria-label={`${formatDate(d, { weekday: true })}${de.length ? ` 予定${de.length}件` : ''}`}
                onClick={() => select(d)}
              >
                <span className="num">{date.getDate()}</span>
                <span className="dots">
                  {de.slice(0, 3).map((e) => (
                    <span key={e.id} className="dot" style={{ background: colorVar(e.categoryId ? catMap.get(e.categoryId)?.color : 'teal') }} />
                  ))}
                </span>
              </button>
            );
          })}
        </div>

        <h2 className="section-title">{formatDate(selected, { weekday: true })}の予定</h2>
        {dayEvents.length === 0 ? (
          <EmptyState icon="calendar" title="予定はありません" />
        ) : (
          <ul className="list">
            {dayEvents.map((e) => {
              const cat = e.categoryId ? catMap.get(e.categoryId) : undefined;
              return (
                <li className="row" key={e.id}>
                  <div className="time-col">{timeLabel(e, selected)}</div>
                  <button className="row-main" onClick={() => setEditing(e)}>
                    <div className="row-title">{e.title}</div>
                    <div className="row-sub" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      {cat && (
                        <span className="badge">
                          <span className="dot" style={{ background: colorVar(cat.color), width: 8, height: 8 }} />
                          {cat.name}
                        </span>
                      )}
                      {!e.allDay && e.startDate === e.endDate && `${isoToLocalTime(e.start)}〜${isoToLocalTime(e.end)}`}
                      {e.startDate !== e.endDate && `〜${formatDate(e.endDate)}`}
                      {e.location && ` ・ ${e.location}`}
                    </div>
                  </button>
                  <span className="avatars">
                    {e.memberIds.slice(0, 3).map((id) => (
                      <Avatar key={id} member={members.get(id)} size="sm" />
                    ))}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </main>
      <Fab label="予定" onClick={() => setEditing('new')} />
      {editing && <EventSheet event={editing === 'new' ? null : editing} date={selected} onClose={() => setEditing(null)} />}
    </>
  );
}

function EventSheet({ event, date, onClose }: { event: CalendarEvent | null; date: string; onClose: () => void }) {
  const { db, session } = useApp();
  const members = useMembers();
  const categories = useCategories('event');
  const { confirm, toast } = useFeedback();
  const [title, setTitle] = useState(event?.title ?? '');
  const [allDay, setAllDay] = useState(event?.allDay ?? false);
  const [startDate, setStartDate] = useState(event?.startDate ?? date);
  const [endDate, setEndDate] = useState(event?.endDate ?? date);
  const [startTime, setStartTime] = useState(event && !event.allDay ? isoToLocalTime(event.start) : '10:00');
  const [endTime, setEndTime] = useState(event && !event.allDay ? isoToLocalTime(event.end) : '11:00');
  const [memberIds, setMemberIds] = useState<string[]>(event?.memberIds ?? [session.memberId]);
  const [categoryId, setCategoryId] = useState<string | null>(event?.categoryId ?? categories[0]?.id ?? null);
  const [location, setLocation] = useState(event?.location ?? '');
  const [note, setNote] = useState(event?.note ?? '');
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setError(null);
    if (!title.trim()) return setError('タイトルを入力してください');
    const start = allDay ? startDate : localToIso(startDate, startTime);
    let end = allDay ? (endDate < startDate ? startDate : endDate) : localToIso(endDate < startDate ? startDate : endDate, endTime);
    if (!allDay && end < start) end = start;
    const fields = {
      title: title.trim(),
      allDay,
      start,
      end,
      startDate: allDay ? startDate : isoToLocalDate(start),
      endDate: allDay ? (endDate < startDate ? startDate : endDate) : isoToLocalDate(end),
      memberIds,
      categoryId,
      location: location.trim(),
      note: note.trim(),
    };
    try {
      if (event) await update(db, session, 'events', event.id, fields);
      else await create(db, session, 'events', fields);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const remove = async () => {
    if (!event || !(await confirm({ title: '予定を削除', message: `「${event.title}」を削除します。`, confirmLabel: '削除', danger: true }))) return;
    await softDelete(db, session, 'events', event.id);
    toast({ message: '予定を削除しました', onAction: () => void restoreDeleted(db, session, 'events', event.id) });
    onClose();
  };

  return (
    <Sheet title={event ? '予定を編集' : '予定を追加'} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="タイトル">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={LIMITS.title} placeholder="例: 保護者会" />
        </Field>
        <Switch label="終日" checked={allDay} onChange={setAllDay} />
        <div className="field-row">
          <Field label="開始日">
            <input
              className="input"
              type="date"
              value={startDate}
              onChange={(e) => {
                if (!e.target.value) return;
                setStartDate(e.target.value);
                if (endDate < e.target.value) setEndDate(e.target.value);
              }}
            />
          </Field>
          {!allDay && (
            <Field label="開始時刻">
              <input className="input" type="time" value={startTime} onChange={(e) => e.target.value && setStartTime(e.target.value)} />
            </Field>
          )}
        </div>
        <div className="field-row">
          <Field label="終了日">
            <input className="input" type="date" value={endDate} min={startDate} onChange={(e) => e.target.value && setEndDate(e.target.value)} />
          </Field>
          {!allDay && (
            <Field label="終了時刻">
              <input className="input" type="time" value={endTime} onChange={(e) => e.target.value && setEndTime(e.target.value)} />
            </Field>
          )}
        </div>
        <Field label="参加する家族" group>
          <MemberPicker members={members} value={memberIds} onChange={setMemberIds} multiple />
        </Field>
        <Field label="カテゴリー">
          <select className="select" value={categoryId ?? ''} onChange={(e) => setCategoryId(e.target.value || null)}>
            <option value="">なし</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="場所">
          <input className="input" value={location} onChange={(e) => setLocation(e.target.value)} maxLength={LIMITS.location} />
        </Field>
        <Field label="メモ">
          <textarea className="textarea" value={note} onChange={(e) => setNote(e.target.value)} maxLength={LIMITS.note} rows={3} />
        </Field>
        {error && <p className="error-text">{error}</p>}
        <button className="btn primary block" type="submit">
          保存
        </button>
        {event && (
          <button className="btn danger block" type="button" onClick={() => void remove()}>
            <Icon name="trash" />
            削除
          </button>
        )}
      </form>
    </Sheet>
  );
}
