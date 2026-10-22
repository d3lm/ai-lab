export interface Page<T> {
  items: T[];
  /** 1-based page number actually returned (out-of-range requests are clamped). */
  page: number;
  totalPages: number;
  hasNext: boolean;
}

export function paginate<T>(all: readonly T[], page: number, pageSize: number): Page<T> {
  if (pageSize <= 0) throw new RangeError("pageSize must be positive");
  const totalPages = Math.max(1, Math.ceil(all.length / pageSize));
  const current = Math.min(Math.max(1, page), totalPages);
  const start = (current - 1) * pageSize;
  return {
    items: all.slice(start, start + pageSize),
    page: current,
    totalPages,
    hasNext: current < totalPages,
  };
}
