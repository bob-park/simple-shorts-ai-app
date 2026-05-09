import { useState } from 'react';

import { HistoryGridView } from '@renderer/components/history/HistoryGridView';
import { HistoryListView } from '@renderer/components/history/HistoryListView';
import { JobDetailDrawer } from '@renderer/components/history/JobDetailDrawer';
import { useHistory } from '@renderer/hooks/useHistory';
import type { JobStatus } from '@shared/history';

const STATUS_OPTIONS: { value: JobStatus; label: string }[] = [
  { value: 'done', label: '완료' },
  { value: 'partial_done', label: '부분' },
  { value: 'failed', label: '실패' },
  { value: 'canceled', label: '취소' },
];

export function HistoryPage() {
  const { query, setQuery, state, refresh } = useHistory();
  const [view, setView] = useState<'list' | 'grid'>('list');
  const [activeJobId, setActiveJobId] = useState<string | null>(null);

  const toggleStatus = (s: JobStatus) => {
    setQuery((q) => ({
      ...q,
      statusFilter: q.statusFilter.includes(s) ? q.statusFilter.filter((x) => x !== s) : [...q.statusFilter, s],
    }));
  };

  return (
    <section className="gap-xl p-section flex flex-col">
      <header>
        <h1 className="text-heading-md text-ink font-semibold">히스토리</h1>
      </header>

      <div className="gap-md flex items-center">
        <input
          type="search"
          value={query.search}
          onChange={(e) => setQuery((q) => ({ ...q, search: e.target.value }))}
          placeholder="제목, 채널, 하이라이트 검색..."
          className="border-hairline px-md text-body-md h-10 flex-1 rounded-full border"
        />
        <select
          value={query.sortBy}
          onChange={(e) => setQuery((q) => ({ ...q, sortBy: e.target.value as typeof q.sortBy }))}
          className="border-hairline px-md text-body-md h-10 rounded-full border"
        >
          <option value="newest">최신순</option>
          <option value="title">제목순</option>
          <option value="duration">길이순</option>
        </select>
        <button
          type="button"
          onClick={() => setView((v) => (v === 'list' ? 'grid' : 'list'))}
          className="border-hairline px-md text-body-md h-10 rounded-full border"
        >
          {view === 'list' ? '그리드 보기' : '리스트 보기'}
        </button>
      </div>

      <div className="gap-sm flex">
        {STATUS_OPTIONS.map((opt) => {
          const active = query.statusFilter.includes(opt.value);
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => toggleStatus(opt.value)}
              className={`px-md text-body-sm h-8 rounded-full border ${
                active ? 'bg-primary text-on-primary border-primary' : 'border-hairline text-slate'
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      {state.status === 'loading' ? <p className="text-body-md text-slate">로딩 중...</p> : null}
      {state.status === 'error' ? <p className="text-body-md text-brand-coral">오류: {state.error.message}</p> : null}
      {state.status === 'done' ? (
        view === 'list' ? (
          <HistoryListView jobs={state.jobs} onRowClick={setActiveJobId} />
        ) : (
          <HistoryGridView jobs={state.jobs} onRowClick={setActiveJobId} />
        )
      ) : null}

      <JobDetailDrawer
        jobId={activeJobId}
        onClose={() => setActiveJobId(null)}
        onDelete={async (id) => {
          await window.api.historyDelete(id);
          refresh();
        }}
      />
    </section>
  );
}
