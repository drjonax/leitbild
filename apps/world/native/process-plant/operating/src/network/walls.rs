//! spec: world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/pressurizer-thermal-state.md#shell-and-head-metal
//! The PZR shell bands and heads of the stratified cell, and the band
//! enclosures that couple them with the heater rods.
//!
//! The shell's bands of `ld01-pzr-shell` and its two flat heads are finite
//! 304 steel stores (`reference-304-caloric`). Each has one lumped energy
//! coordinate, the lead's selection, since the page selects no
//! through-thickness node count. Its contact and exterior surfaces share
//! that one steel temperature, and heat never moves between elements.
//!
//! The cell's `wall_wetting` gives each element its contact. Wet parts use
//! the heater's complete wet construction (thermal.rs's heater branch) at
//! the contacted zone's centroid state, with `wetSensibleCoefficient_W_m2K`.
//! The shell uses Bromley's film over its fixed development length; the
//! heads use the effective vapor resistance. The zone contacts, each with
//! its self-consistent minimum-film endpoint, are the ones the rods use.
//! Dry parts use the exposed gas law and condensation of
//! `ld01-pzr-heater-contact` against g's column point. Each element loses
//! heat to the ambient through the insulation path, a massless series
//! resistance per unit steel outer surface. A band's outer surface is
//! `2π(R+t)Δz`; a head's is its gross plate.
//!
//! Each shell band carries one area-mixed enclosure. Its members are the
//! band's exposed shell, the exposed area of each heater rod segment in
//! the band, and, in the top band, the top head. Each member gives
//! `Q = A ε (σT⁴ − J)`, and the band's exchanges sum to zero. Receipts reach
//! the cell as `WallReceipt`s and every element's steel receives the
//! opposite of its fluid terms. Nothing is clipped, floored or defaulted.
use super::{
    Failure,
    heaters::{
        Caloric304, ContactBlock, HeaterCase, Heaters, LiquidContact, SegmentRates, zone_point,
    },
    stratified::{Cell, Column, HeaterReceipt, WallElement, WallReceipt, WallWetting},
};
use crate::thermal::{
    self, Film, FilmBranch, GasContact, HeaterFilm, SB, Scalar, WallFlux, WallLaw, WallMaterial,
    WaterProperties,
};
use serde::Deserialize;

fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}
fn fatal(reason: impl Into<String>) -> Failure {
    Failure::Fatal(format!("PZR walls: {}", reason.into()))
}
fn recoverable(reason: impl Into<String>) -> Failure {
    Failure::Recoverable(format!("PZR walls: {}", reason.into()))
}
fn finite(v: Scalar, what: &str) -> Result<Scalar, Failure> {
    if v.value.is_finite() && v.direction.is_finite() {
        Ok(v)
    } else {
        Err(recoverable(format!("nonfinite {what}")))
    }
}
fn positive_finite(values: &[(&str, f64)]) -> Result<(), Failure> {
    for (name, v) in values {
        if !(v.is_finite() && *v > 0.) {
            return Err(fatal(format!(
                "{name} must be positive and finite, not {v}"
            )));
        }
    }
    Ok(())
}
fn present(x: Scalar) -> bool {
    x.value != 0. || x.direction != 0.
}
/// Agreement within the strict blocks' printed precision.
fn agrees(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1e-6 * a.abs().max(b.abs())
}

/// The exterior path of `ld01-pzr-shell`.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Insulation {
    pub thickness_m: f64,
    #[serde(rename = "conductivity_W_m_K")]
    pub conductivity_w_m_k: f64,
    #[serde(rename = "exteriorCoefficient_W_m2K")]
    pub exterior_coefficient_w_m2_k: f64,
    #[serde(rename = "ambient_K")]
    pub ambient_k: f64,
}
/// The `ld01-pzr-shell` strict block.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShellBlock {
    #[serde(rename = "grossArea_m2")]
    pub gross_area_m2: f64,
    #[serde(rename = "shellThickness_m")]
    pub shell_thickness_m: f64,
    /// Bands above the PZR bottom, contiguous over the vessel.
    #[serde(rename = "shellBands_m")]
    pub shell_bands_m: Vec<[f64; 2]>,
    #[serde(rename = "shellMass_kg")]
    pub shell_mass_kg: f64,
    #[serde(rename = "headThickness_m")]
    pub head_thickness_m: f64,
    #[serde(rename = "headMass_kg")]
    pub head_mass_kg: f64,
    #[serde(rename = "bottomHeadContactArea_m2")]
    pub bottom_head_contact_area_m2: f64,
    #[serde(rename = "topHeadContactArea_m2")]
    pub top_head_contact_area_m2: f64,
    #[serde(rename = "wetSensibleCoefficient_W_m2K")]
    pub wet_sensible_coefficient_w_m2_k: f64,
    #[serde(rename = "shellFilmDevelopmentLength_m")]
    pub shell_film_development_length_m: f64,
    #[serde(rename = "headFilmResistanceLength_m")]
    pub head_film_resistance_length_m: f64,
    #[serde(rename = "headFilmResistanceSensitivity_m")]
    pub head_film_resistance_sensitivity_m: [f64; 2],
    pub insulation: Insulation,
}

/// One run's wall sensitivity selection: the shared contact case and the
/// heads' resistance length, nominal or one of the block's sensitivities.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WallCase {
    pub contact: HeaterCase,
    pub head_film_resistance_length_m: f64,
}
impl WallCase {
    pub fn nominal(contact: &ContactBlock, shell: &ShellBlock) -> Self {
        Self {
            contact: HeaterCase::nominal(contact),
            head_film_resistance_length_m: shell.head_film_resistance_length_m,
        }
    }
}

/// One wall element compiled onto the plant datum.
#[derive(Clone, Copy, Debug)]
pub struct Element {
    pub element: WallElement,
    pub steel_mass_kg: f64,
    /// Fluid and optical contact: a band's inner perimeter times its
    /// length, or a head's net patch.
    pub contact_area_m2: f64,
    /// Steel outer surface of the insulation path.
    pub outer_area_m2: f64,
    /// The shell band whose enclosure this element joins: a band its own,
    /// the top head the top band, the bottom head none.
    pub enclosure: Option<usize>,
}

/// The coordinates the walls add: one differential steel energy (J, from
/// the 304 datum) per element, bands upward, then the bottom and top head.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Census {
    pub coordinates: Vec<String>,
    pub differential: usize,
    pub algebraic: usize,
}

/// One wall element's sources in one evaluation.
#[derive(Clone, Copy, Debug)]
pub struct ElementRates {
    pub receipt: WallReceipt,
    /// The steel's energy rate: minus its fluid receipts, its outward
    /// enclosure exchange and its exterior loss, W.
    pub metal_rate: Scalar,
    /// The fluid's energy receipt as the cell books it, W.
    pub fluid_energy_w: Scalar,
    /// Outward enclosure exchange, W.
    pub radiation_w: Scalar,
    /// Heat to the ambient through the insulation path, W.
    pub exterior_w: Scalar,
    pub temperature: Scalar,
    pub wetting: WallWetting,
    /// Contact areas with A, R and the vapor zone.
    pub areas: [Scalar; 3],
    pub admitted: Option<WallFlux>,
    pub resident: Option<WallFlux>,
    pub dry: Option<GasContact>,
}

/// Every PZR metal source of one evaluation: rod segments and wall
/// elements, coupled by the band enclosures.
#[derive(Clone, Debug)]
pub struct MetalRates {
    pub rods: Vec<SegmentRates>,
    /// Each rod segment's outward enclosure exchange, W. Its complete steel
    /// rate is `rods[j].metal_rate − rod_radiation_w[j]`.
    pub rod_radiation_w: Vec<Scalar>,
    pub walls: Vec<ElementRates>,
    /// The contacted A and R zones, shared by rods and walls.
    pub contacts: [Option<LiquidContact>; 2],
    /// One per contacted liquid zone and one per dry contact's dew point.
    pub saturation_calls: usize,
}
impl MetalRates {
    pub fn heater_receipts(&self) -> Vec<HeaterReceipt> {
        self.rods.iter().map(|r| r.receipt).collect()
    }
    pub fn wall_receipts(&self) -> Vec<WallReceipt> {
        self.walls.iter().map(|w| w.receipt).collect()
    }
    /// Complete rod steel rates, enclosure exchange included.
    pub fn rod_metal_rates(&self) -> Vec<Scalar> {
        self.rods
            .iter()
            .zip(&self.rod_radiation_w)
            .map(|(r, q)| r.metal_rate - *q)
            .collect()
    }
    pub fn wall_metal_rates(&self) -> Vec<Scalar> {
        self.walls.iter().map(|w| w.metal_rate).collect()
    }
}

/// The diffuse area-mixed enclosure: `J = Σ A ε σT⁴ / Σ A ε` and outward
/// `Q_i = A_i ε (σT_i⁴ − J)`; zero exposed area exchanges nothing, before
/// any division.
pub fn enclosure(members: &[(Scalar, Scalar)], emissivity: f64) -> Vec<Scalar> {
    let total = members.iter().fold(s(0.), |a, (area, _)| a + *area);
    if total.value == 0. {
        return vec![s(0.); members.len()];
    }
    let emission = |t: Scalar| s(SB) * t * t * t * t;
    let j = members
        .iter()
        .fold(s(0.), |a, (area, t)| a + *area * emission(*t))
        / total;
    members
        .iter()
        .map(|(area, t)| s(emissivity) * *area * (emission(*t) - j))
        .collect()
}

/// The shell bands and heads of one stratified cell.
#[derive(Clone, Debug)]
pub struct Walls {
    elements: Vec<Element>,
    bands: usize,
    /// The shell band holding each heater rod segment.
    rod_band: Vec<usize>,
    inner_diameter_m: f64,
    caloric: Caloric304,
    contact: ContactBlock,
    shell: ShellBlock,
    case: WallCase,
}

impl Walls {
    /// Admits the shell block against the cell and the rods: contiguous
    /// bands over the vessel, masses consistent with the geometry and the
    /// 304 density, contact patches inside the gross area, and every rod
    /// segment inside one band.
    pub fn new(
        cell: &Cell,
        heaters: &Heaters,
        shell: ShellBlock,
        caloric: Caloric304,
        contact: ContactBlock,
        case: WallCase,
    ) -> Result<Self, Failure> {
        caloric.validate()?;
        contact.validate()?;
        case.contact.validate(&contact)?;
        let i = &shell.insulation;
        positive_finite(&[
            ("grossArea_m2", shell.gross_area_m2),
            ("shellThickness_m", shell.shell_thickness_m),
            ("shellMass_kg", shell.shell_mass_kg),
            ("headThickness_m", shell.head_thickness_m),
            ("headMass_kg", shell.head_mass_kg),
            (
                "bottomHeadContactArea_m2",
                shell.bottom_head_contact_area_m2,
            ),
            ("topHeadContactArea_m2", shell.top_head_contact_area_m2),
            (
                "wetSensibleCoefficient_W_m2K",
                shell.wet_sensible_coefficient_w_m2_k,
            ),
            (
                "shellFilmDevelopmentLength_m",
                shell.shell_film_development_length_m,
            ),
            (
                "headFilmResistanceLength_m",
                shell.head_film_resistance_length_m,
            ),
            ("insulation thickness_m", i.thickness_m),
            ("insulation conductivity_W_m_K", i.conductivity_w_m_k),
            (
                "insulation exteriorCoefficient_W_m2K",
                i.exterior_coefficient_w_m2_k,
            ),
            ("insulation ambient_K", i.ambient_k),
        ])?;
        let length = case.head_film_resistance_length_m;
        if !(length == shell.head_film_resistance_length_m
            || shell.head_film_resistance_sensitivity_m.contains(&length))
        {
            return Err(fatal(format!(
                "head resistance length {length} m is not declared"
            )));
        }
        let p = cell.parameters();
        let height = p.top_m - p.bottom_m;
        let (Some(first), Some(last)) = (shell.shell_bands_m.first(), shell.shell_bands_m.last())
        else {
            return Err(fatal("the shell declares no bands"));
        };
        if first[0] != 0. || last[1] != height {
            return Err(fatal("shell bands must cover the vessel"));
        }
        let radius = (shell.gross_area_m2 / std::f64::consts::PI).sqrt();
        let outer = radius + shell.shell_thickness_m;
        let ring = std::f64::consts::PI * (outer * outer - radius * radius);
        if !agrees(caloric.density_kg_m3 * ring * height, shell.shell_mass_kg)
            || !agrees(
                caloric.density_kg_m3 * shell.gross_area_m2 * shell.head_thickness_m,
                shell.head_mass_kg,
            )
            || shell.bottom_head_contact_area_m2 > shell.gross_area_m2
            || shell.top_head_contact_area_m2 > shell.gross_area_m2
        {
            return Err(fatal(
                "shell or head mass or contact area disagrees with its geometry",
            ));
        }
        let mut elements = Vec::with_capacity(shell.shell_bands_m.len() + 2);
        for (j, [from, to]) in shell.shell_bands_m.iter().copied().enumerate() {
            if !(from.is_finite() && to.is_finite() && from < to)
                || (j > 0 && shell.shell_bands_m[j - 1][1] != from)
            {
                return Err(fatal("shell bands must ascend contiguously"));
            }
            let dz = to - from;
            elements.push(Element {
                element: WallElement::Band {
                    bottom_m: p.bottom_m + from,
                    top_m: p.bottom_m + to,
                },
                steel_mass_kg: shell.shell_mass_kg * dz / height,
                contact_area_m2: 2. * std::f64::consts::PI * radius * dz,
                outer_area_m2: 2. * std::f64::consts::PI * outer * dz,
                enclosure: Some(j),
            });
        }
        let bands = elements.len();
        elements.push(Element {
            element: WallElement::BottomHead,
            steel_mass_kg: shell.head_mass_kg,
            contact_area_m2: shell.bottom_head_contact_area_m2,
            outer_area_m2: shell.gross_area_m2,
            enclosure: None,
        });
        elements.push(Element {
            element: WallElement::TopHead,
            steel_mass_kg: shell.head_mass_kg,
            contact_area_m2: shell.top_head_contact_area_m2,
            outer_area_m2: shell.gross_area_m2,
            enclosure: Some(bands - 1),
        });
        let rod_band = heaters
            .segments()
            .iter()
            .map(|g| {
                elements[..bands]
                    .iter()
                    .position(|e| match e.element {
                        WallElement::Band { bottom_m, top_m } => {
                            bottom_m <= g.bottom_m && g.top_m <= top_m
                        }
                        _ => false,
                    })
                    .ok_or_else(|| {
                        fatal(format!(
                            "rod segment [{}, {}] m crosses a shell band edge",
                            g.bottom_m, g.top_m
                        ))
                    })
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            elements,
            bands,
            rod_band,
            inner_diameter_m: 2. * radius,
            caloric,
            contact,
            shell,
            case,
        })
    }

    pub fn elements(&self) -> &[Element] {
        &self.elements
    }
    pub fn rod_band(&self) -> &[usize] {
        &self.rod_band
    }

    /// One differential steel energy per element; nothing algebraic.
    pub fn census(&self) -> Census {
        Census {
            coordinates: self
                .elements
                .iter()
                .map(|e| match e.element {
                    WallElement::Band { bottom_m, top_m } => {
                        format!("shell band [{bottom_m}, {top_m}] m steel energy U (J)")
                    }
                    WallElement::BottomHead => "bottom head steel energy U (J)".into(),
                    WallElement::TopHead => "top head steel energy U (J)".into(),
                })
                .collect(),
            differential: self.elements.len(),
            algebraic: 0,
        }
    }

    /// Every element's steel energy at one uniform steel temperature.
    pub fn prepared_energy(&self, temperature_k: f64) -> Result<Vec<f64>, Failure> {
        let e = self.caloric.specific_energy(s(temperature_k))?.value;
        Ok(self.elements.iter().map(|x| x.steel_mass_kg * e).collect())
    }

    /// The element's wet law with the zone's 304 endpoint material: the
    /// heater's construction with the shell's sensible coefficient, and
    /// Bromley over the shell's length or the heads' vapor resistance. The
    /// heater branch uses no diameter; the vessel's inner one is passed.
    fn law(&self, element: &Element, material: WallMaterial) -> WallLaw {
        let (w, c) = (&self.contact.wet, &self.case.contact);
        let film = match element.element {
            WallElement::Band { .. } => FilmBranch::Vertical {
                coefficient: w.bromley_coefficient,
                length_m: self.shell.shell_film_development_length_m,
                convection_factor: c.film_convection_factor,
            },
            WallElement::BottomHead | WallElement::TopHead => FilmBranch::Resistance {
                length_m: self.case.head_film_resistance_length_m,
            },
        };
        WallLaw {
            diameter_m: self.inner_diameter_m,
            film: Film::Heater(HeaterFilm {
                sensible_w_m2_k: self.shell.wet_sensible_coefficient_w_m2_k,
                onset_contact_angle_deg: w.onset_contact_angle_deg,
                wall_birth_fraction: c.wall_birth_fraction,
                minimum_film_bounds_k: w.minimum_film_bounds_k,
                film,
            }),
            emissivity: w.film_radiation_coefficient,
            material,
        }
    }

    /// The wet law per square metre of one element at a wall temperature.
    pub fn wet_flux<P: WaterProperties>(
        &self,
        index: usize,
        contact: &LiquidContact,
        wall_t: Scalar,
        props: &P,
    ) -> Result<WallFlux, Failure> {
        let element = &self.elements[index];
        thermal::liquid_wall_current(
            props,
            contact.pressure,
            contact.temperature,
            wall_t,
            s(0.),
            self.law(element, contact.material()),
            contact.saturation,
            contact.point,
        )
        .map_err(|e| {
            recoverable(format!(
                "{:?} wet contact at {} Pa, liquid {} K, wall {} K: {e}",
                element.element, contact.pressure.value, contact.temperature.value, wall_t.value
            ))
        })
    }

    /// The exterior loss through the insulation path, W.
    pub fn exterior(&self, index: usize, temperature: Scalar) -> Scalar {
        let i = &self.shell.insulation;
        let resistance = i.thickness_m / i.conductivity_w_m_k + 1. / i.exterior_coefficient_w_m2_k;
        s(self.elements[index].outer_area_m2 / resistance) * (temperature - s(i.ambient_k))
    }

    /// Every rod segment's and wall element's sources from the column, the
    /// rods' and elements' steel energy coordinates and each bank's power.
    #[allow(clippy::too_many_arguments)]
    pub fn rates<P: WaterProperties>(
        &self,
        cell: &Cell,
        column: &Column,
        heaters: &Heaters,
        rod_metal: &[Scalar],
        bank_power_w: &[f64],
        wall_metal: &[Scalar],
        props: &P,
    ) -> Result<MetalRates, Failure> {
        let segments = heaters.segments();
        if rod_metal.len() != segments.len()
            || bank_power_w.len() != heaters.banks().len()
            || wall_metal.len() != self.elements.len()
            || self.rod_band.len() != segments.len()
        {
            return Err(fatal(
                "steel energies, bank powers and rods must match the compiled walls",
            ));
        }
        let rod_wetting = segments
            .iter()
            .map(|g| cell.heater_wetting(column, g.bottom_m, g.top_m))
            .collect::<Result<Vec<_>, _>>()?;
        let wall_wetting = self
            .elements
            .iter()
            .map(|e| cell.wall_wetting(column, e.element))
            .collect::<Result<Vec<_>, _>>()?;
        let wets = |rods: fn(&super::stratified::Wetting) -> Scalar,
                    walls: fn(&WallWetting) -> Scalar| {
            rod_wetting.iter().any(|w| present(rods(w)))
                || wall_wetting.iter().any(|w| present(walls(w)))
        };
        let wets_a = wets(|w| w.admitted_length_m, |w| w.admitted_fraction);
        let wets_r = wets(|w| w.resident_length_m, |w| w.resident_fraction);
        let mut saturation_calls = 0;
        let mut contact = |wets: bool,
                           zone: &super::stratified::Zone|
         -> Result<Option<LiquidContact>, Failure> {
            if !wets {
                return Ok(None);
            }
            saturation_calls += 1;
            heaters.liquid_contact(zone, props).map(Some)
        };
        let contacts = [
            contact(wets_a, &column.admitted)?,
            contact(wets_r, &column.resident)?,
        ];

        let mut rods = Vec::with_capacity(segments.len());
        for (j, (g, w)) in segments.iter().zip(&rod_wetting).enumerate() {
            let out = heaters.segment_rates(
                j,
                column,
                w,
                rod_metal[j],
                bank_power_w[g.bank],
                &contacts,
                props,
            )?;
            saturation_calls += usize::from(out.exposed.is_some());
            rods.push(out);
        }

        let mut walls = Vec::with_capacity(self.elements.len());
        for (k, (e, w)) in self.elements.iter().zip(&wall_wetting).enumerate() {
            let t = self
                .caloric
                .temperature(wall_metal[k] / s(e.steel_mass_kg))?;
            let area = s(e.contact_area_m2);
            let areas = [
                area * w.admitted_fraction,
                area * w.resident_fraction,
                area * w.vapor_fraction,
            ];
            let wet = |a: Scalar, c: &Option<LiquidContact>| -> Result<Option<WallFlux>, Failure> {
                match (present(a), c) {
                    (false, _) => Ok(None),
                    (true, Some(c)) => self.wet_flux(k, c, t, props).map(Some),
                    (true, None) => Err(fatal(format!(
                        "{:?} wets a zone without its contact",
                        e.element
                    ))),
                }
            };
            let admitted = wet(areas[0], &contacts[0])?;
            let resident = wet(areas[1], &contacts[1])?;
            let dry = if present(areas[2]) {
                saturation_calls += 1;
                Some(self.dry_flux(column, t, props)?)
            } else {
                None
            };
            let mut heat = [s(0.); 2];
            let mut vapor = [s(0.); 2];
            for (z, q) in [admitted, resident].iter().enumerate() {
                if let Some(q) = q {
                    heat[z] = finite(areas[z] * q.heat, "wall wet heat")?;
                    vapor[z] = finite(areas[z] * q.vapor_mass, "wall vapor")?;
                }
            }
            // No condensate carries no enthalpy: its product with j is zero.
            let (dry_heat, condensate, condensate_enthalpy) = match dry {
                None => (s(0.), s(0.), s(0.)),
                Some(x) => match x.condensation {
                    None => (areas[2] * x.sensible, s(0.), s(0.)),
                    Some(c) => (areas[2] * x.sensible, areas[2] * c.mass, c.liquid_enthalpy),
                },
            };
            let fluid = heat[0] + heat[1] + dry_heat - condensate * column.vapor.enthalpy
                + condensate * condensate_enthalpy;
            let receipt = WallReceipt {
                element: e.element,
                wet_heat_w: heat,
                wet_vapor_kg_s: vapor,
                dry_heat_w: finite(dry_heat, "wall dry heat")?,
                condensate_kg_s: finite(condensate, "wall condensate")?,
                condensate_enthalpy_j_kg: finite(condensate_enthalpy, "condensate enthalpy")?,
            };
            walls.push(ElementRates {
                receipt,
                metal_rate: s(0.),
                fluid_energy_w: fluid,
                radiation_w: s(0.),
                exterior_w: self.exterior(k, t),
                temperature: t,
                wetting: *w,
                areas,
                admitted,
                resident,
                dry,
            });
        }

        // One enclosure per shell band: its exposed shell, the exposed rod
        // segments inside it and, in the top band, the top head.
        let mut rod_radiation_w = vec![s(0.); segments.len()];
        let emissivity = self.contact.exposed.enclosure_emissivity;
        for band in 0..self.bands {
            let walls_in: Vec<usize> = (0..self.elements.len())
                .filter(|k| self.elements[*k].enclosure == Some(band))
                .collect();
            let rods_in: Vec<usize> = (0..segments.len())
                .filter(|j| self.rod_band[*j] == band)
                .collect();
            let members: Vec<(Scalar, Scalar)> = walls_in
                .iter()
                .map(|k| (walls[*k].areas[2], walls[*k].temperature))
                .chain(
                    rods_in
                        .iter()
                        .map(|j| (rods[*j].areas[2], rods[*j].temperature)),
                )
                .collect();
            let q = enclosure(&members, emissivity);
            for (n, k) in walls_in.iter().enumerate() {
                walls[*k].radiation_w = finite(q[n], "wall radiation")?;
            }
            for (n, j) in rods_in.iter().enumerate() {
                rod_radiation_w[*j] = finite(q[walls_in.len() + n], "rod radiation")?;
            }
        }
        for w in &mut walls {
            w.metal_rate = finite(
                -w.fluid_energy_w - w.radiation_w - w.exterior_w,
                "wall steel rate",
            )?;
        }
        Ok(MetalRates {
            rods,
            rod_radiation_w,
            walls,
            contacts,
            saturation_calls,
        })
    }

    /// The dry gas law per square metre against the vapor zone, with g's
    /// column point as the donor steam.
    pub fn dry_flux<P: WaterProperties>(
        &self,
        column: &Column,
        wall_t: Scalar,
        props: &P,
    ) -> Result<GasContact, Failure> {
        let vapor = &column.vapor;
        if vapor.mass.value <= 0. {
            return Err(recoverable("a dry wall contact needs the vapor zone"));
        }
        let x = &self.contact.exposed;
        let point = zone_point(vapor);
        thermal::gas_contact(
            props,
            vapor.pressure,
            vapor.temperature,
            wall_t,
            x.gas_coefficient_w_m2_k * self.case.contact.gas_coefficient_factor,
            x.condensation_speed_m_s,
            Some(|| Ok(point)),
        )
        .map_err(|e| {
            recoverable(format!(
                "dry wall contact at {} Pa, gas {} K, wall {} K: {e}",
                vapor.pressure.value, vapor.temperature.value, wall_t.value
            ))
        })
    }
}
