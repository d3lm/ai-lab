#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Align {
    Left,
    Right,
}

/// Renders rows as a padded table. Each column is as wide as its widest cell
/// (capped at `max_width`; longer cells are cut and end in `…`). Columns are
/// separated by two spaces and trailing spaces are trimmed from every line.
pub fn render(header: &[&str], rows: &[Vec<String>], align: &[Align], max_width: usize) -> String {
    let cols = header.len();
    let mut widths: Vec<usize> = header.iter().map(|h| h.chars().count()).collect();
    for row in rows {
        for (i, cell) in row.iter().enumerate().take(cols) {
            widths[i] = widths[i].max(cell.chars().count());
        }
    }
    for w in &mut widths {
        *w = (*w).min(max_width);
    }
    let mut out = String::new();
    let header_row: Vec<String> = header.iter().map(|h| h.to_string()).collect();
    for row in std::iter::once(&header_row).chain(rows) {
        let mut line = String::new();
        for i in 0..cols {
            let cell = truncate(row.get(i).map(String::as_str).unwrap_or(""), widths[i]);
            let pad = widths[i] - cell.chars().count();
            if i > 0 {
                line.push_str("  ");
            }
            match align.get(i).copied().unwrap_or(Align::Left) {
                Align::Left => {
                    line.push_str(&cell);
                    line.push_str(&" ".repeat(pad));
                }
                Align::Right => {
                    line.push_str(&" ".repeat(pad));
                    line.push_str(&cell);
                }
            }
        }
        out.push_str(line.trim_end());
        out.push('\n');
    }
    out
}

fn truncate(cell: &str, width: usize) -> String {
    if cell.chars().count() <= width {
        return cell.to_string();
    }
    let mut s: String = cell.chars().take(width.saturating_sub(1)).collect();
    s.push('…');
    s
}
