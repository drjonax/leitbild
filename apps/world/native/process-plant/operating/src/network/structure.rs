//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-equations.md#6-solver-properties-and-cost-obligations
//! Conservative structural sparsity of the composed network's stage Jacobian.
//!
//! Derived once from compiled topology: face endpoints, momentum supports,
//! pressure segments, force/velocity projections, section projections and
//! the PZR field. It must contain every entry any state can produce, so it
//! couples through upwind donor switches and absent-phase one-sided charts.
//! The PZR field is treated as one coupled block. Callers verify numerically
//! that sampled dense Jacobians are contained in this pattern.
use super::{Network, Properties};
use std::collections::BTreeSet;

impl<P: Properties> Network<P> {
    fn cell_coordinates(&self, cell: usize) -> std::ops::Range<usize> {
        let base = self.cell_layout[cell].base;
        base..base + 6
    }
    fn face_coordinates(&self, face: usize) -> [usize; 2] {
        [
            self.face_layout[2 * face].index,
            self.face_layout[2 * face + 1].index,
        ]
    }
    fn touch(&self, face: usize) -> BTreeSet<usize> {
        let f = &self.faces[face];
        let mut cells = BTreeSet::from([f.from, f.to]);
        cells.extend(f.supports.iter().map(|s| s.region));
        cells.extend(f.pressure_segments.iter().map(|s| s.region));
        cells.extend(self.projections[face].iter().map(|p| p.region));
        cells
    }
    fn endpoint_faces(&self, cell: usize) -> Vec<usize> {
        (0..self.faces.len())
            .filter(|j| self.faces[*j].from == cell || self.faces[*j].to == cell)
            .collect()
    }
    /// Coordinates on which a face's transported flux can depend.
    fn flux_dependencies(&self, face: usize, out: &mut BTreeSet<usize>) {
        out.extend(self.face_coordinates(face));
        for cell in self.touch(face) {
            out.extend(self.cell_coordinates(cell));
        }
    }

    /// Row indices per column, sorted and unique: a structural superset.
    pub fn structural_pattern(&self) -> Vec<Vec<usize>> {
        let n = self.scales.len();
        let mut columns: Vec<BTreeSet<usize>> = vec![BTreeSet::new(); n];
        let mut add = |rows: &BTreeSet<usize>, cols: &BTreeSet<usize>| {
            for c in cols {
                columns[*c].extend(rows.iter().copied());
            }
        };
        // Cell rows: own coordinates and fluxes of faces ending at the cell.
        for cell in 0..self.cells.len() {
            let rows: BTreeSet<usize> = self.cell_coordinates(cell).collect();
            let mut cols: BTreeSet<usize> = self.cell_coordinates(cell).collect();
            for g in self.endpoint_faces(cell) {
                self.flux_dependencies(g, &mut cols);
            }
            add(&rows, &cols);
        }
        // Momentum rows: own chart, and the mass rates of supporting cells.
        for face in 0..self.faces.len() {
            let rows: BTreeSet<usize> = self.face_coordinates(face).into_iter().collect();
            let mut cols = BTreeSet::new();
            self.flux_dependencies(face, &mut cols);
            for support in &self.faces[face].supports {
                for g in self.endpoint_faces(support.region) {
                    self.flux_dependencies(g, &mut cols);
                }
            }
            add(&rows, &cols);
        }
        // Sections: region, projected face charts and rotor drive their faces,
        // rotor row and the pump-water energy receipt.
        for (s, h) in self.sections.iter().enumerate() {
            let faces: Vec<usize> = self
                .section_projection
                .iter()
                .filter(|(_, section, _)| *section == s)
                .map(|(face, _, _)| *face)
                .collect();
            let mut rows: BTreeSet<usize> = self.cell_coordinates(h.region).collect();
            let mut cols: BTreeSet<usize> = self.cell_coordinates(h.region).collect();
            for face in &faces {
                rows.extend(self.face_coordinates(*face));
                self.flux_dependencies(*face, &mut cols);
            }
            if let Some(r) = h.rotor {
                rows.insert(self.rotor_index[r]);
                cols.insert(self.rotor_index[r]);
            }
            add(&rows, &cols);
        }
        // PZR field: one coupled block over every face touching a PZR cell.
        let pzr_faces: Vec<usize> = (0..self.faces.len())
            .filter(|face| {
                *face >= self.first_pzr_face
                    || self.touch(*face).iter().any(|c| *c >= self.pzr_begin)
            })
            .collect();
        let mut rows = BTreeSet::new();
        let mut cols = BTreeSet::new();
        for cell in self.pzr_begin..self.cells.len() {
            rows.extend(self.cell_coordinates(cell));
        }
        for face in &pzr_faces {
            rows.extend(self.face_coordinates(*face));
            self.flux_dependencies(*face, &mut cols);
        }
        add(&rows, &cols);
        // Every coordinate appears on its own row (IDA's cj diagonal).
        for (c, rows) in columns.iter_mut().enumerate() {
            rows.insert(c);
        }
        columns
            .into_iter()
            .map(|rows| rows.into_iter().collect())
            .collect()
    }
}
