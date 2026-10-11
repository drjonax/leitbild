//! spec: world/packs/process-plant/reference-designs/ld-01/model/build-readiness.md#owner-decision-request-4-11-october-delegated
//! The restart rule for constrained coordinates (sixth P2 case run): the
//! shared exact consistent start places a nonnegative coordinate on its
//! bound only when it lies below it by less than the declared tolerance in
//! solver scaling, reports the placement, and refuses a larger violation.
use leitbild_operating_plant::network::{
    ConsistentSystem, Failure, Placement, consistent_start, place_on_bounds,
};

/// Two decaying stocks, the second constrained to be nonnegative.
struct Stocks;
impl ConsistentSystem for Stocks {
    fn system_dimension(&self) -> usize {
        2
    }
    fn rows_at(&mut self, _: f64, y: &[f64], yp: &[f64]) -> Result<Vec<f64>, Failure> {
        Ok(vec![yp[0] + y[0], yp[1] + y[1]])
    }
    fn pencil_at(&mut self, _: f64, _: &[f64], _: &[f64]) -> Result<(Vec<f64>, Vec<f64>), Failure> {
        // dF/dy and dF/dy', column-major.
        Ok((vec![1., 0., 0., 1.], vec![1., 0., 0., 1.]))
    }
    fn restart_bounds(&self) -> Option<(Vec<usize>, f64)> {
        Some((vec![1], 1e-12))
    }
}

fn restart(y: &mut [f64]) -> Result<Vec<Placement>, Failure> {
    consistent_start(&mut Stocks, 7.5, y, &[1., 1.], &[1., 1.], 1e-12, 2).map(|(_, p)| p.placements)
}

#[test]
fn a_roundoff_violation_is_placed_on_its_bound_and_reported() {
    let mut y = [0.4, -3e-25];
    let placed = restart(&mut y).unwrap();
    assert_eq!(y, [0.4, 0.]);
    assert_eq!(
        placed,
        vec![Placement {
            time: 7.5,
            coordinate: 1,
            value: -3e-25
        }]
    );
}

#[test]
fn a_larger_violation_refuses_and_nothing_else_is_moved() {
    let mut y = [0.4, -1e-10];
    match restart(&mut y) {
        Err(Failure::Fatal(reason)) => assert!(reason.contains("coordinate 1"), "{reason}"),
        other => panic!("expected a refusal, got {other:?}"),
    }
    assert_eq!(y, [0.4, -1e-10]);
    // At the bound and above it, and unconstrained coordinates, stay as given.
    let mut y = [-0.2, 0.];
    assert!(restart(&mut y).unwrap().is_empty());
    assert_eq!(y, [-0.2, 0.]);
    assert!(place_on_bounds(0., &mut [-1e-13], &[0], f64::NAN).is_err());
}
