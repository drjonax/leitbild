//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-scale-realization.md#high-performance-mathematics-without-changing-the-physical-question
//! Fixed sparse structure and exact compressed directional Jacobian recovery.
//!
//! A `Pattern` is an immutable, validated compressed-sparse-column structure:
//! rows are strictly increasing and in range within every column. A `Coloring`
//! partitions its columns so that no two columns of one color share a row. One
//! directional evaluation `J*d` per color, seeded with +1 or -1 on exactly that
//! color's columns, then recovers every stored entry of those columns. Each
//! stored row receives one column's term, so `scatter` divides it by that
//! column's seed sign; no finite difference, tolerance or approximation enters.
//! The caller's directional evaluation must be linear in the seed over each
//! color (true for branches selected by values, not by direction).
//!
//! The pattern must contain every actual dependency. `scatter` refuses a
//! nonzero response at a row that no column of the color may touch, because
//! that proves an omitted dependency; it also refuses non-finite responses.
//! Hot-path helpers write caller-owned buffers. Nothing here owns physics.
use std::cmp::Reverse;

pub type Result<T> = std::result::Result<T, String>;
const UNCOLORED: usize = usize::MAX;

/// Immutable compressed-sparse-column structure without numerical values.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pattern {
    rows: usize,
    pointers: Vec<usize>,
    indices: Vec<usize>,
}

impl Pattern {
    /// Admit an explicit CSC structure. `pointers` has one entry more than
    /// there are columns, starts at zero, never decreases and ends at the
    /// number of `indices`; each column's rows strictly increase below `rows`.
    pub fn new(rows: usize, pointers: Vec<usize>, indices: Vec<usize>) -> Result<Self> {
        check_pointers(&pointers, indices.len())?;
        for (column, span) in pointers.windows(2).enumerate() {
            check_line("column", column, &indices[span[0]..span[1]], rows)?;
        }
        Ok(Self {
            rows,
            pointers,
            indices,
        })
    }

    /// One strictly increasing row list per column.
    pub fn from_columns(rows: usize, columns: &[Vec<usize>]) -> Result<Self> {
        let indices = columns.iter().flatten().copied().collect();
        Self::new(rows, offsets(columns.iter().map(Vec::len)), indices)
    }

    /// One strictly increasing column list per row, such as the variables each
    /// residual equation reads; stored by column.
    pub fn from_rows(columns: usize, rows: &[Vec<usize>]) -> Result<Self> {
        for (row, list) in rows.iter().enumerate() {
            check_line("row", row, list, columns)?;
        }
        let mut counts = vec![0; columns];
        for &column in rows.iter().flatten() {
            counts[column] += 1;
        }
        let pointers = offsets(counts.into_iter());
        let mut next = pointers[..columns].to_vec();
        let mut indices = vec![0; pointers[columns]];
        for (row, list) in rows.iter().enumerate() {
            for &column in list {
                indices[next[column]] = row;
                next[column] += 1;
            }
        }
        Self::new(rows.len(), pointers, indices)
    }

    /// Entrywise structural union of two equally shaped patterns, for example
    /// the `dF/dy` and `dF/dyp` structures of one IDA iteration matrix.
    pub fn union(&self, other: &Self) -> Result<Self> {
        if self.rows != other.rows || self.columns() != other.columns() {
            return Err(format!(
                "pattern union needs equal shapes, not {}x{} and {}x{}",
                self.rows,
                self.columns(),
                other.rows,
                other.columns()
            ));
        }
        let mut indices = Vec::with_capacity(self.nonzeros().max(other.nonzeros()));
        let mut pointers = Vec::with_capacity(self.pointers.len());
        pointers.push(0);
        for column in 0..self.columns() {
            merge_sorted(self.column(column), other.column(column), &mut indices);
            pointers.push(indices.len());
        }
        Self::new(self.rows, pointers, indices)
    }

    pub fn rows(&self) -> usize {
        self.rows
    }

    pub fn columns(&self) -> usize {
        self.pointers.len() - 1
    }

    pub fn nonzeros(&self) -> usize {
        self.indices.len()
    }

    pub fn pointers(&self) -> &[usize] {
        &self.pointers
    }

    pub fn indices(&self) -> &[usize] {
        &self.indices
    }

    /// Rows stored in `column`. Panics when `column >= columns()`.
    pub fn column(&self, column: usize) -> &[usize] {
        &self.indices[self.pointers[column]..self.pointers[column + 1]]
    }

    /// Position of stored entry (`row`, `column`) in CSC value order.
    pub fn position(&self, row: usize, column: usize) -> Option<usize> {
        let start = self.pointers[column];
        self.column(column)
            .binary_search(&row)
            .ok()
            .map(|offset| start + offset)
    }

    /// (column pointers, row indices) in the 64-bit CSC ABI of stock SUNDIALS
    /// INT64 sparse matrices and KLU's `klu_l` interface.
    pub fn to_i64(&self) -> Result<(Vec<i64>, Vec<i64>)> {
        Ok((to_i64(&self.pointers)?, to_i64(&self.indices)?))
    }

    /// Row-major transpose of the structure: (row pointers, column indices).
    fn row_major(&self) -> (Vec<usize>, Vec<usize>) {
        let mut counts = vec![0; self.rows];
        for &row in &self.indices {
            counts[row] += 1;
        }
        let pointers = offsets(counts.into_iter());
        let mut next = pointers[..self.rows].to_vec();
        let mut columns = vec![0; self.nonzeros()];
        for column in 0..self.columns() {
            for &row in self.column(column) {
                columns[next[row]] = column;
                next[row] += 1;
            }
        }
        (pointers, columns)
    }
}

/// Partition of a pattern's columns into structurally orthogonal groups.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Coloring {
    colors: Vec<usize>,
    groups: Vec<Vec<usize>>,
    /// Sorted rows that the columns of each color store.
    claimed: Vec<Vec<usize>>,
}

impl Coloring {
    /// Greedy distance-1 coloring of the column intersection graph: columns
    /// are visited by decreasing stored-row count, ties by index, and each
    /// takes the smallest color unused by every column sharing one of its rows.
    pub fn greedy(pattern: &Pattern) -> Self {
        let (row_pointers, row_columns) = pattern.row_major();
        let mut colors = vec![UNCOLORED; pattern.columns()];
        // stamp[c] == column marks color c as taken by a neighbour of column.
        let mut stamp: Vec<usize> = Vec::new();
        for column in degree_order(pattern) {
            for &row in pattern.column(column) {
                for &neighbour in &row_columns[row_pointers[row]..row_pointers[row + 1]] {
                    if let Some(taken) = stamp.get_mut(colors[neighbour]) {
                        *taken = column;
                    }
                }
            }
            let color = stamp
                .iter()
                .position(|&taken| taken != column)
                .unwrap_or(stamp.len());
            if color == stamp.len() {
                stamp.push(UNCOLORED);
            }
            colors[column] = color;
        }
        Self::build(pattern, colors)
    }

    /// Admit an explicit grouping, such as one color per column for a
    /// per-column reference evaluation. Colors must be dense from zero and
    /// structurally orthogonal on `pattern`.
    pub fn new(pattern: &Pattern, colors: Vec<usize>) -> Result<Self> {
        if colors.len() != pattern.columns() {
            return Err(format!(
                "{} colors for {} columns",
                colors.len(),
                pattern.columns()
            ));
        }
        if let Some((column, color)) = colors
            .iter()
            .enumerate()
            .find(|(_, color)| **color >= pattern.columns())
        {
            return Err(format!(
                "column {column} color {color} exceeds the column count"
            ));
        }
        let coloring = Self::build(pattern, colors);
        coloring.verify(pattern)?;
        Ok(coloring)
    }

    /// Check that the coloring belongs to `pattern`, uses every color and
    /// never gives one row two columns of the same color.
    pub fn verify(&self, pattern: &Pattern) -> Result<()> {
        self.matches(pattern)?;
        if let Some(color) = self.groups.iter().position(Vec::is_empty) {
            return Err(format!("color {color} has no column"));
        }
        for (color, rows) in self.claimed.iter().enumerate() {
            if let Some(shared) = rows.windows(2).find(|pair| pair[0] == pair[1]) {
                return Err(format!(
                    "color {color} gives row {} to two columns",
                    shared[0]
                ));
            }
        }
        Ok(())
    }

    pub fn count(&self) -> usize {
        self.groups.len()
    }

    /// Color of `column`. Panics when `column` is outside the pattern.
    pub fn color(&self, column: usize) -> usize {
        self.colors[column]
    }

    /// Ascending columns of `color`.
    pub fn columns(&self, color: usize) -> Result<&[usize]> {
        self.groups
            .get(color)
            .map(Vec::as_slice)
            .ok_or_else(|| format!("color {color} outside 0..{}", self.count()))
    }

    /// Direction vector with `column_signs[j]` (exactly +1 or -1) on the
    /// columns of `color` and zero elsewhere.
    pub fn seed(&self, color: usize, column_signs: &[f64]) -> Result<Vec<f64>> {
        let mut direction = vec![0.; self.colors.len()];
        self.seed_into(color, column_signs, &mut direction)?;
        Ok(direction)
    }

    /// Allocation-free `seed` into a caller-owned direction buffer.
    pub fn seed_into(
        &self,
        color: usize,
        column_signs: &[f64],
        direction: &mut [f64],
    ) -> Result<()> {
        let group = self.columns(color)?;
        check_length("column signs", column_signs.len(), self.colors.len())?;
        check_length("seed direction", direction.len(), self.colors.len())?;
        for &column in group {
            seed_sign(column_signs, column)?;
        }
        direction.fill(0.);
        for &column in group {
            direction[column] = column_signs[column];
        }
        Ok(())
    }

    fn build(pattern: &Pattern, colors: Vec<usize>) -> Self {
        let count = colors.iter().map(|color| color + 1).max().unwrap_or(0);
        let mut groups = vec![Vec::new(); count];
        for (column, &color) in colors.iter().enumerate() {
            groups[color].push(column);
        }
        let claimed = groups
            .iter()
            .map(|group| {
                let mut rows: Vec<usize> = group
                    .iter()
                    .flat_map(|&column| pattern.column(column).iter().copied())
                    .collect();
                rows.sort_unstable();
                rows
            })
            .collect();
        Self {
            colors,
            groups,
            claimed,
        }
    }

    fn matches(&self, pattern: &Pattern) -> Result<()> {
        let stored: usize = self.claimed.iter().map(Vec::len).sum();
        if self.colors.len() != pattern.columns()
            || stored != pattern.nonzeros()
            || self
                .claimed
                .iter()
                .any(|rows| rows.last().is_some_and(|&row| row >= pattern.rows()))
        {
            return Err("coloring was not built for this pattern".into());
        }
        Ok(())
    }
}

/// Recover the CSC values of every column of `color` from one directional
/// response `row_directions = J*seed(color, column_signs)`. Every row outside
/// the color's stored rows must respond with exactly zero and every stored row
/// finitely. On refusal `values` is unchanged.
pub fn scatter(
    pattern: &Pattern,
    coloring: &Coloring,
    color: usize,
    row_directions: &[f64],
    column_signs: &[f64],
    values: &mut [f64],
) -> Result<()> {
    coloring.matches(pattern)?;
    check_length("row directions", row_directions.len(), pattern.rows())?;
    check_length("column signs", column_signs.len(), pattern.columns())?;
    check_length("values", values.len(), pattern.nonzeros())?;
    let group = coloring.columns(color)?;
    for &column in group {
        seed_sign(column_signs, column)?;
    }
    check_response(color, &coloring.claimed[color], row_directions)?;
    for &column in group {
        let sign = column_signs[column];
        for position in pattern.pointers[column]..pattern.pointers[column + 1] {
            values[position] = row_directions[pattern.indices[position]] / sign;
        }
    }
    Ok(())
}

/// One stored or structurally zero entry compared with a dense reference.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Entry {
    pub row: usize,
    pub column: usize,
    pub expected: f64,
    pub actual: f64,
}

/// Comparison of CSC values with a dense reference matrix.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DenseComparison {
    /// Stored entries whose bits differ from the dense value.
    pub bitwise_differences: usize,
    /// Differing stored entry with the largest |actual-expected|; NaN ranks as infinite.
    pub largest_stored_difference: Option<Entry>,
    /// Dense entries that are nonzero or NaN where the pattern stores nothing.
    pub unstored_nonzeros: usize,
    /// Unstored dense entry of largest magnitude; NaN ranks as infinite.
    pub largest_unstored: Option<Entry>,
}

impl DenseComparison {
    pub fn is_bitwise_exact(&self) -> bool {
        self.bitwise_differences == 0 && self.unstored_nonzeros == 0
    }
}

/// Compare `values` on `pattern` with column-major `dense`, whose entry
/// (row, column) is `dense[column * rows + row]`.
pub fn compare_with_dense(
    pattern: &Pattern,
    values: &[f64],
    dense: &[f64],
) -> Result<DenseComparison> {
    check_length("values", values.len(), pattern.nonzeros())?;
    check_length(
        "dense matrix",
        dense.len(),
        pattern.rows() * pattern.columns(),
    )?;
    let mut comparison = DenseComparison::default();
    for column in 0..pattern.columns() {
        let reference = &dense[column * pattern.rows()..(column + 1) * pattern.rows()];
        let mut stored = (pattern.pointers[column]..pattern.pointers[column + 1]).peekable();
        for (row, &expected) in reference.iter().enumerate() {
            let entry = |actual| Entry {
                row,
                column,
                expected,
                actual,
            };
            match stored.next_if(|&position| pattern.indices[position] == row) {
                Some(position) if values[position].to_bits() != expected.to_bits() => {
                    comparison.bitwise_differences += 1;
                    keep_largest(
                        &mut comparison.largest_stored_difference,
                        entry(values[position]),
                    );
                }
                None if expected != 0. => {
                    comparison.unstored_nonzeros += 1;
                    keep_largest(&mut comparison.largest_unstored, entry(0.));
                }
                _ => {}
            }
        }
    }
    Ok(comparison)
}

fn keep_largest(slot: &mut Option<Entry>, candidate: Entry) {
    if slot.is_none_or(|current| rank(candidate) > rank(current)) {
        *slot = Some(candidate);
    }
}

/// |actual-expected| with NaN ranked above every finite or infinite size.
fn rank(entry: Entry) -> f64 {
    let size = (entry.actual - entry.expected).abs();
    if size.is_nan() { f64::INFINITY } else { size }
}

fn check_response(color: usize, claimed: &[usize], row_directions: &[f64]) -> Result<()> {
    let mut claimed = claimed.iter().peekable();
    for (row, &value) in row_directions.iter().enumerate() {
        let stored = claimed.next_if_eq(&&row).is_some();
        if stored && !value.is_finite() {
            return Err(format!(
                "color {color}: non-finite directional response {value} at row {row}"
            ));
        }
        if !stored && value != 0. {
            return Err(format!(
                "color {color}: response {value} at row {row}, which no column of this color stores; the pattern omits a dependency"
            ));
        }
    }
    Ok(())
}

fn seed_sign(column_signs: &[f64], column: usize) -> Result<f64> {
    match column_signs[column] {
        sign if sign == 1. || sign == -1. => Ok(sign),
        sign => Err(format!("column {column} seed sign {sign} is not +1 or -1")),
    }
}

fn degree_order(pattern: &Pattern) -> Vec<usize> {
    let mut order: Vec<usize> = (0..pattern.columns()).collect();
    order.sort_by_key(|&column| (Reverse(pattern.column(column).len()), column));
    order
}

fn merge_sorted(a: &[usize], b: &[usize], out: &mut Vec<usize>) {
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        let next = a[i].min(b[j]);
        out.push(next);
        i += usize::from(a[i] == next);
        j += usize::from(b[j] == next);
    }
    out.extend_from_slice(&a[i..]);
    out.extend_from_slice(&b[j..]);
}

fn offsets(lengths: impl Iterator<Item = usize>) -> Vec<usize> {
    std::iter::once(0)
        .chain(lengths.scan(0, |total, length| {
            *total += length;
            Some(*total)
        }))
        .collect()
}

fn check_pointers(pointers: &[usize], nonzeros: usize) -> Result<()> {
    match (pointers.first(), pointers.last()) {
        (Some(0), Some(&last)) if last == nonzeros && pointers.is_sorted() => Ok(()),
        _ => Err(format!(
            "CSC pointers must start at 0, never decrease and end at {nonzeros}"
        )),
    }
}

fn check_line(kind: &str, index: usize, entries: &[usize], bound: usize) -> Result<()> {
    if let Some(pair) = entries.windows(2).find(|pair| pair[0] >= pair[1]) {
        return Err(format!(
            "{kind} {index}: entries {} then {} are not strictly increasing",
            pair[0], pair[1]
        ));
    }
    match entries.last() {
        Some(&last) if last >= bound => Err(format!(
            "{kind} {index}: entry {last} is outside 0..{bound}"
        )),
        _ => Ok(()),
    }
}

fn check_length(name: &str, actual: usize, expected: usize) -> Result<()> {
    if actual == expected {
        Ok(())
    } else {
        Err(format!("{name} length {actual}, expected {expected}"))
    }
}

fn to_i64(values: &[usize]) -> Result<Vec<i64>> {
    values
        .iter()
        .map(|&value| i64::try_from(value).map_err(|_| format!("sparse index {value} exceeds i64")))
        .collect()
}
