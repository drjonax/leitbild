//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#joined-block-interface
//! The network's ports to the owners composed with it in one residual.
//!
//! One evaluation of the network computes every regular cell's state from
//! its retained M/U/B and every face chart first. A [`Coupling`] is then
//! called once with that state ([`Fluid`]) and may add receipts into the
//! regular cells ([`Receipts`]) before any section, momentum or stock row is
//! composed. The liquid enthalpy receipt is the single heat port: thermal
//! owners deliver non-advective heat there, so phase-volume work is paid
//! once by the network's own rate closure. Receipts enter the network's
//! stock rows exactly as its face receipts do, value and direction alike.
//! The stratified PZR cell takes its surge-port receipt from the face and
//! everything else that enters it (heater and wall receipts, zone heat and
//! the relief lift with its receiver) from the owner of the PZR metal and
//! relief through [`Coupling::pzr_boundary`], on the cell's column of the
//! same evaluation (G6). A network evaluated without a coupling has no such
//! owner: its boundary is closed, with a declared relief held on its seat
//! ([`Network::uncoupled_pzr_boundary`], S1 and the preparations).
//!
//! Moving cell volumes ([`CellVolume`]) are the rod owner's port, consumed
//! by [`Network::evaluate_joined`]: the EOS row, the phase rate closure and
//! the face inertance take the current volume (memo Table 1.2, "Rod
//! displacement and work"); [`Fluid::current_volumes`] reports it.
use super::{Failure, Network, Properties, Water, rec, s, stratified};
use crate::{
    local_flow::{Cell, Chart},
    thermal::Scalar,
};

/// Standard gravity of the network's well-balanced face head.
pub const G: f64 = 9.80665;

/// The network's fluid state of one evaluation, read-only. Indices are the
/// compiled region order (packet `mechanics.regions`): regular cells, then
/// the stratified PZR cell, whose entry in `cells` is its port view.
#[derive(Clone, Copy, Debug)]
pub struct Fluid<'a> {
    pub cells: &'a [Cell],
    /// Regular cells only: the maintained caloric point of each present (or
    /// leading-receipt) phase, value then direction; `None` when absent.
    pub points: &'a [[Option<(Water, Water)>; 2]],
    /// Regular cells only: retained phase masses (kg), liquid then vapor,
    /// and the liquid tracer amount (kg_eq), with their directions.
    pub liquid_mass: &'a [Scalar],
    pub vapor_mass: &'a [Scalar],
    pub tracer: &'a [Scalar],
    /// Every face and phase: the chart of this evaluation (flows, donors).
    pub charts: &'a [[Option<Chart>; 2]],
    /// Faces' compiled endpoints, `(from, to)`.
    pub endpoints: &'a [(usize, usize)],
    /// Region pressure-reference elevations and compiled fluid volumes.
    pub elevations: &'a [f64],
    pub volumes: &'a [f64],
    /// Regular cells only: this evaluation's free volume with its direction,
    /// the compiled volume for a fixed cell, the moving one for a moving cell.
    pub current_volumes: &'a [Scalar],
}

impl Fluid<'_> {
    /// Mixture density `sum(alpha*rho)` of a cell's present phases.
    pub fn mixture_density(&self, cell: usize) -> Scalar {
        self.cells[cell]
            .phase
            .into_iter()
            .flatten()
            .fold(s(0.), |sum, p| sum + p.fraction * p.density)
    }
    /// Local static pressure at `elevation`, reconstructed from the cell's
    /// reference pressure with its mixture density: the network's own
    /// well-balanced head `p + rho_mix g (z_ref - z)`.
    pub fn pressure_at(&self, cell: usize, elevation: f64) -> Scalar {
        self.cells[cell].pressure
            + self.mixture_density(cell) * s(G * (self.elevations[cell] - elevation))
    }
    /// Liquid mass flow of a face (kg/s, positive from `from` to `to`).
    pub fn liquid_mass_flow(&self, face: usize) -> Scalar {
        self.charts[face][0].map_or(s(0.), |c| c.mass_flow_kg_s)
    }
}

/// Receipts into the network's regular cells: `[mass kg/s, enthalpy W,
/// tracer kg_eq/s]` per phase (0 liquid, 1 vapor); positive enters the cell.
pub struct Receipts<'a> {
    cells: &'a mut [[[Scalar; 3]; 2]],
}

impl<'a> Receipts<'a> {
    pub fn new(cells: &'a mut [[[Scalar; 3]; 2]]) -> Self {
        Self { cells }
    }
    pub fn cells(&self) -> usize {
        self.cells.len()
    }
    /// Add one receipt. A cell outside the regular cells or a nonfinite
    /// value is refused.
    pub fn add(
        &mut self,
        cell: usize,
        phase: usize,
        mass: Scalar,
        enthalpy: Scalar,
        tracer: Scalar,
    ) -> Result<(), Failure> {
        if cell >= self.cells.len() || phase > 1 {
            return Err(Failure::Fatal(format!(
                "receipt into cell {cell} phase {phase} outside the regular cells"
            )));
        }
        for v in [mass, enthalpy, tracer] {
            if !(v.value.is_finite() && v.direction.is_finite()) {
                return Err(Failure::Recoverable(format!(
                    "nonfinite receipt into cell {cell} phase {phase}"
                )));
            }
        }
        let r = &mut self.cells[cell][phase];
        r[0] = r[0] + mass;
        r[1] = r[1] + enthalpy;
        r[2] = r[2] + tracer;
        Ok(())
    }
    /// A non-advective liquid heat (W): the single heat port.
    pub fn heat(&mut self, cell: usize, heat_w: Scalar) -> Result<(), Failure> {
        self.add(cell, 0, s(0.), heat_w, s(0.))
    }
    pub fn get(&self, cell: usize, phase: usize) -> [Scalar; 3] {
        self.cells[cell][phase]
    }
}

/// Current fluid volume of one regular network cell and its rate.
#[derive(Clone, Copy, Debug)]
pub struct CellVolume {
    pub volume_m3: Scalar,
    pub rate_m3_s: Scalar,
}

/// An owner composed into one network evaluation.
pub trait Coupling {
    /// Called once per evaluation after every regular cell's state and every
    /// face chart is current, before any section, momentum or stock row.
    fn couple(&mut self, fluid: &Fluid<'_>, receipts: &mut Receipts<'_>) -> Result<(), Failure>;
    /// The stratified cell's boundary of this evaluation: heater and wall
    /// receipts, zone heat and the relief state, evaluated by the owner of
    /// the PZR metal and relief on `column`, the cell's column of the same
    /// evaluation (with its directions), and on the owner's own coordinates.
    /// Called once per evaluation, after [`Coupling::couple`] and every
    /// regular row, immediately before the cell's own rows.
    fn pzr_boundary(
        &mut self,
        cell: &stratified::Cell,
        column: &stratified::Column,
    ) -> Result<stratified::Boundary, Failure>;
}

impl<P: Properties> Network<P> {
    /// Region pressure-reference elevations, packet order.
    pub fn elevations(&self) -> &[f64] {
        &self.elevations
    }
    /// The stratified cell's boundary with no coupled owner of the PZR metal
    /// and relief (S1, the network alone, and the preparations): no heater,
    /// wall or zone heat, and a declared relief held on its seat with no
    /// receiver composed, so it carries nothing and a lift refuses.
    pub fn uncoupled_pzr_boundary(&self) -> stratified::Boundary {
        let seated = self
            .stratified
            .parameters()
            .ports
            .iter()
            .any(|p| p.kind == stratified::PortKind::Relief)
            .then_some(stratified::ReliefState {
                lift: s(0.),
                back_pressure_pa: None,
            });
        stratified::Boundary {
            relief: seated,
            ..stratified::Boundary::closed()
        }
    }
    /// The coupling step of [`Network::evaluate_coupled`]: build the fluid
    /// view of this evaluation, let the coupling add its receipts, and add
    /// them to the network's face receipts.
    pub(super) fn couple(
        &mut self,
        coupling: &mut dyn Coupling,
        y: &[f64],
        seed: Option<&[f64]>,
        points: &[[Option<(Water, Water)>; 2]],
        phase_mass: &[Vec<Scalar>; 2],
    ) -> Result<(), Failure> {
        let n = self.pzr.cell;
        for (node, l) in self.cell_layout.iter().enumerate() {
            self.coupled_tracer[node] = rec(
                y[l.boron] * self.scales[l.boron],
                seed.map_or(0., |d| d[l.boron]) * self.scales[l.boron],
            );
        }
        self.coupled_receipts.fill([[s(0.); 3]; 2]);
        let fluid = Fluid {
            cells: &self.cells,
            points,
            liquid_mass: &phase_mass[0],
            vapor_mass: &phase_mass[1],
            tracer: &self.coupled_tracer,
            charts: &self.charts,
            endpoints: &self.endpoints,
            elevations: &self.elevations,
            volumes: &self.volumes,
            current_volumes: &self.cell_volume,
        };
        coupling.couple(&fluid, &mut Receipts::new(&mut self.coupled_receipts[..n]))?;
        for node in 0..n {
            for k in 0..2 {
                for j in 0..3 {
                    self.receipts[node][k][j] =
                        self.receipts[node][k][j] + self.coupled_receipts[node][k][j];
                }
            }
        }
        Ok(())
    }
}
