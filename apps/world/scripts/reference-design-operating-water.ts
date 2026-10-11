/** Build the opt-in narrow native IF97 boundary. This is a build artifact, not
 * a second equation-of-state implementation or an application dependency. */
import {createHash} from 'node:crypto'
import {mkdir, mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {nativeIf97HeaderSha256, nativeIf97LicenseSha256, nativeIf97Revision, nativeIf97Source} from './reference-design-if97-primitives'
import {metastableSchema, ownedBlock, pzrOwners} from './reference-design-operating-pzr'

const hash=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex')

// spec: world/packs/process-plant/reference-designs/ld-01/model/operating-phase-properties.md#bounded-metastable-admission
// The band and both pressure ceilings have one numeric owner: the wiki strict
// block ld01-metastable-band on this page. The build reads it from an explicit
// wiki root, compiles it into the bridge and records the page hash and the
// parsed band in its receipt; the native boundary exposes the compiled band.
export const metastableBandPage='world/packs/process-plant/reference-designs/ld-01/model/'+pzrOwners.metastable.page.replace(/^model\//,'')
/** IF97 R7-97 (2007) Section 6.2: metastable vapor at p <= 10 MPa is Eq. (18). */
export const if97Equation18PressureMax_Pa=10e6
/** One pressure range of the band on its own branch equations: region-1
 * Eq. (7) for liquid, and Eq. (15), or Eq. (18) at or below 10 MPa, for vapor. */
export type MetastableRange={pressure_Pa:[number,number],lowerBoundExclusive:boolean,
  liquidSuperheatMax_K:number,vaporSubcoolingMax_K:number,vaporEquation:15|18}
export type MetastableBand={ranges:MetastableRange[],trialMax_K:number,creditedMax_K:number,
  liquidTemperatureMax_K:number,liquidPressureCeiling_Pa:number,vaporPressureCeiling_Pa:number}

/** The compilers' strict block, normalized to its two adjoining ranges. The
 * vapor equation of each follows IF97's own assignment, which the block's
 * declared low-range equation must agree with. */
export function parseMetastableBand(value:unknown):MetastableBand{
  const b=metastableSchema.parse(value),l=b.lowPressureBand
  const range=(pressure_Pa:[number,number],lowerBoundExclusive:boolean,liquid:number,vapor:number):MetastableRange=>{
    const vaporEquation=pressure_Pa[1]<=if97Equation18PressureMax_Pa?18:pressure_Pa[0]>=if97Equation18PressureMax_Pa?15:0
    if(vaporEquation===0)throw Error(`Metastable range ${pressure_Pa} straddles the Eq. (18) limit`)
    return {pressure_Pa,lowerBoundExclusive,liquidSuperheatMax_K:liquid,vaporSubcoolingMax_K:vapor,vaporEquation}
  }
  const ranges=[range(b.pressureRange_Pa,b.lowerBoundExclusive,b.liquidSuperheatMax_K,b.vaporSubcoolingMax_K),
    range(l.pressureRange_Pa,l.lowerBoundExclusive,l.liquidSuperheatMax_K,l.vaporSubcoolingMax_K)]
  if(ranges[0]!.vaporEquation!==15||ranges[1]!.vaporEquation!==18)
    throw Error('The low-pressure range must be the Eq. (18) range below the Eq. (15) range')
  return {ranges,trialMax_K:b.trialMax_K,creditedMax_K:b.creditedMax_K,liquidTemperatureMax_K:b.liquidTemperatureMax_K,
    liquidPressureCeiling_Pa:b.liquidPressureCeiling_Pa,vaporPressureCeiling_Pa:b.vaporPressureCeiling_Pa}
}

// One authored adapter is shared with the existing forward preparation reader.
// C++ exceptions never cross the C ABI; output is written only on success.
export const operatingWaterBridge=(band:MetastableBand)=>String.raw`
#include <algorithm>
#include <cmath>
#include <limits>
#include <stdexcept>
#include <string>
void require(bool condition,const std::string& message) {
 if(!condition) throw std::domain_error(message);
}
thread_local double max_forward_p=0,max_dense_endpoint_p_error=0;
${nativeIf97Source(true)}
// Caloric-inverse state of the SAME forward point, for its brackets and iterates
// only: rho, u, h, cp and alpha, the fields that inverse reads. Each function
// mirrors its full counterpart above: the same checks in the same order and the
// same member calls on the same arguments, without entropy, cv, sound speed,
// compressibility, transport or the p-only saturation slope. Its values are
// therefore bit-identical to ld01_water_point's. R3, R5 and dilute states, all
// refused by this R1/R2 boundary, take the full path.
template<class R> State gibbs_caloric(const R& r,int region,double T,double p) {
 const double none=std::numeric_limits<double>::quiet_NaN(),rho=r.rhomass(T,p);
 const State q{region,p,T,rho,r.umass(T,p),r.hmass(T,p),none,r.cpmass(T,p),
  none,none,r.alpha(T,p),none,none,none};
 const std::array<double,7> fields{{q.p,q.T,q.rho,q.u,q.h,q.cp,q.alpha}};
 require(std::all_of(fields.begin(),fields.end(),[](double value){return std::isfinite(value);}),
  "Nonfinite field in returned native tuple");
 return q;
}
State point_caloric(double T,double p) {
 if (!std::isfinite(T)||!std::isfinite(p)||p<=0||T<=0)
  throw std::domain_error("Invalid finite positive PT input");
 switch(IF97::RegionDetermination_TP(T,p)) {
  case IF97::REGION_1: return gibbs_caloric(r1,1,T,p);
  case IF97::REGION_2: return gibbs_caloric(r2,2,T,p);
  case IF97::REGION_3: case IF97::REGION_5: return point(T,p);
  default: throw std::domain_error("Ambiguous PT saturation pair needs explicit endpoint/inventory");
 }
}
State vapor_caloric(double T,double pv) {
 require(std::isfinite(pv)&&pv>0&&T>=IF97::Tmin&&T<=IF97::Text,"Invalid actual vapor PT");
 if(T<=IF97::Tcrit) require(pv<=r4.p_T(T),"Supersaturated vapor is not this active branch");
 if(pv<IF97::Pmin) return vapor(T,pv);
 const auto q=point_caloric(T,pv);
 require(q.region==2||q.region==3||q.region==5,"Actual gas queried a liquid branch");
 return q;
}
State liquid_caloric(double T,double p) {
 require(p>0&&p<IF97::Pcrit&&T<=r4.T_p(p),"Liquid left its stable subcritical branch");
 const auto q=point_caloric(T,p);
 require(q.region==1||q.region==3,"Actual liquid queried a gas branch"); return q;
}
State endpoint_caloric(double p,bool is_liquid) {
 require(p>=IF97::Pmin&&p<IF97::Pcrit,"Unsupported saturation endpoint domain");
 const double T=r4.T_p(p);
 if(T<=IF97::T23min) return is_liquid?gibbs_caloric(r1,1,T,p):gibbs_caloric(r2,2,T,p);
 return endpoint(p,is_liquid);
}
// IF97 Eq. (18), the metastable-vapor equation for p <= 10 MPa (IF97 R7-97,
// Section 6.2): the Eq. (16) ideal part with the readjusted n1, n2 of Table 10
// footnote a, and the Eq. (19) residual part with Table 16; reduced pressure
// p/(1 MPa), tau = 540 K/T, residual tau - 0.5, as region 2's own class. The
// pinned header has no Eq. (18); the shared adapter's region machinery
// evaluates it, transport included, from these published coefficients.
static const RegionResidualElement eq18_residual[]={
 {1,0,-0.73362260186506e-2},{1,2,-0.88223831943146e-1},{1,5,-0.72334555213245e-1},{1,11,-0.40813178534455e-2},
 {2,1,0.20097803380207e-2},{2,7,-0.53045921898642e-1},{2,16,-0.76190409086970e-2},{3,4,-0.63498037657313e-2},
 {3,16,-0.86043093028588e-1},{4,7,0.75321581522770e-2},{4,10,-0.79238375446139e-2},{5,9,-0.22888160778447e-3},
 {5,10,-0.26456501482810e-2}};
static const RegionIdealElement eq18_ideal[]={
 {0,-0.96937268393049e1},{1,0.10087275970006e2},{-5,-0.56087911283020e-2},{-4,0.71452738081455e-1},
 {-3,-0.40710498223928},{-2,0.14240819171444e1},{-1,-0.43839511319450e1},{2,-0.28408632460772},{3,0.21268463753307e-1}};
class Region2Metastable : public IF97::BaseRegion {
public:
 Region2Metastable():BaseRegion(std::vector<RegionResidualElement>(std::begin(eq18_residual),std::end(eq18_residual)),
  std::vector<RegionIdealElement>(std::begin(eq18_ideal),std::end(eq18_ideal))){T_star=540;p_star=1*IF97::p_fact;}
 double TAUrterm(double T) const{return T_star/T-0.5;}
 double PIrterm(double p) const{return p/p_star;}
 double TAU0term(double T) const{return T_star/T;}
};
static const Gibbs<Region2Metastable> r2m;
// Bounded metastable admission: the parsed ld01-metastable-band block, recorded
// with its page hash in the build receipt.
struct BandRange {
 double low_pa,high_pa;bool low_exclusive;double liquid_superheat_max_k,vapor_subcooling_max_k;int vapor_equation;
};
constexpr BandRange band_ranges[]={${band.ranges.map(r=>`{${r.pressure_Pa[0]},${r.pressure_Pa[1]},${r.lowerBoundExclusive},${r.liquidSuperheatMax_K},${r.vaporSubcoolingMax_K},${r.vaporEquation}}`).join(',')}};
constexpr int band_range_count=${band.ranges.length};
constexpr double trial_max_k=${band.trialMax_K},liquid_temperature_max_k=${band.liquidTemperatureMax_K};
constexpr double liquid_ceiling_pa=${band.liquidPressureCeiling_Pa},vapor_ceiling_pa=${band.vaporPressureCeiling_Pa};
constexpr double credited_max_k=${band.creditedMax_K};
constexpr int TRIAL_BAND=4;
// The band range holding p, or -1 (upper bounds inclusive).
int band_range(double p) {
 for(int k=0;k<band_range_count;++k){
  const BandRange& r=band_ranges[k];
  if((r.low_exclusive?p>r.low_pa:p>=r.low_pa)&&p<=r.high_pa)return k;
 }
 return -1;
}
// The metastable side of saturation on an explicit branch: liquid above Tsat;
// vapor below it where the shared adapter's own supersaturation test refuses
// (every vapor state that test admits keeps its unchanged stable path).
bool metastable_side(int branch,double p,double T,double ts) {
 return (branch==0&&T>ts)||(branch==1&&T<ts&&T>=IF97::Tmin&&!(p<=r4.p_T(T)));
}
// Complete forward tuples (the shared adapter) and the caloric-inverse subset.
struct CompleteTuple {
 static State liquid_equation(double T,double p){return gibbs(r1,1,T,p);}
 static State vapor_equation(double T,double p){return gibbs(r2,2,T,p);}
 static State metastable_vapor_equation(double T,double p){return gibbs(r2m,2,T,p);}
 static State stable_liquid(double T,double p){return liquid(T,p);}
 static State stable_vapor(double T,double p){return vapor(T,p);}
 static State saturated(double p,bool is_liquid){return endpoint(p,is_liquid);}
};
struct CaloricTuple {
 static State liquid_equation(double T,double p){return gibbs_caloric(r1,1,T,p);}
 static State vapor_equation(double T,double p){return gibbs_caloric(r2,2,T,p);}
 static State metastable_vapor_equation(double T,double p){return gibbs_caloric(r2m,2,T,p);}
 static State stable_liquid(double T,double p){return liquid_caloric(T,p);}
 static State stable_vapor(double T,double p){return vapor_caloric(T,p);}
 static State saturated(double p,bool is_liquid){return endpoint_caloric(p,is_liquid);}
};
// Admission of the metastable side of saturation: ADMIT_ANY for requests;
// one range k >= 0 for the coefficient probes of a metastable centre on a
// continuous equation (Eq. 7 or Eq. 15); ONLY_METASTABLE+k for the probes of an
// Eq. (18) centre, which may not cross saturation onto Eq. (15); ADMIT_STABLE
// for the probes of a stable-side centre, exactly as before admission.
constexpr int ADMIT_ANY=-1,ADMIT_STABLE=-2,ONLY_METASTABLE=1000;
// Internal branch 5: the vapor branch's metastable equation of a band range
// at saturation, the caloric inverse's bracket end below an Eq. (15) endpoint.
constexpr int METASTABLE_SATURATED_VAPOR=5;
// The explicitly requested branch at (p,T); ts is Tsat(p). An exact saturation
// boundary has two physical branches: honour the caller's branch instead of
// delegating its identity to TP rounding. The stable side of saturation and the
// saturated endpoints take the shared adapter's unchanged paths. With
// admission, the metastable side is the branch's own basic equation of its band
// range: region-1 Eq. (7) for liquid, region-2 Eq. (15) or, at or below 10 MPa,
// the metastable-vapor Eq. (18) for vapor; inside the trial departure only, and
// with no region search and no backward equation. Outside them: TRIAL_BAND.
template<class Tuple> int branch_state(int branch,double p,double T,State& q,double& ts,int admit) {
 require(std::isfinite(p)&&p>=1e5&&p<=(branch==0||branch==2?liquid_ceiling_pa:vapor_ceiling_pa),
  "Operating water pressure domain");
 ts=r4.T_p(p);
 const bool metastable=metastable_side(branch,p,T,ts);
 if(admit>=ONLY_METASTABLE&&!metastable)return TRIAL_BAND;
 if(admit!=ADMIT_STABLE&&metastable){
  const int k=band_range(p);
  if(k<0||(admit>=0&&k!=admit%ONLY_METASTABLE))return TRIAL_BAND;
  const bool liquid=branch==0;
  if(!(liquid?T<=std::min(ts+trial_max_k,liquid_temperature_max_k):T>=ts-trial_max_k))return TRIAL_BAND;
  q=liquid?Tuple::liquid_equation(T,p)
   :band_ranges[k].vapor_equation==18?Tuple::metastable_vapor_equation(T,p):Tuple::vapor_equation(T,p);
 }else switch(branch) {
  case 0:
   if(T==ts){q=Tuple::saturated(p,true);break;}
   require(!(T>liquid_temperature_max_k),"Liquid above the region-1 temperature limit");
   q=Tuple::stable_liquid(T,p);break;
  case 1:q=T==ts?Tuple::saturated(p,false):Tuple::stable_vapor(T,p);break;
  case 2:q=Tuple::saturated(p,true);break;
  case 3:q=Tuple::saturated(p,false);break;
  case METASTABLE_SATURATED_VAPOR:{
   const int k=band_range(p);if(k<0)return TRIAL_BAND;
   q=band_ranges[k].vapor_equation==18?Tuple::metastable_vapor_equation(ts,p):Tuple::vapor_equation(ts,p);break;
  }
  default:return 2;
 }
 require(q.region==1||q.region==2,"Operating water admits R1/R2 only");
 return 0;
}
extern "C" {
struct OperatingWaterPoint {
 int region;
 double p,T,rho,u,h,cp,cv,alpha,kappa,mu,conductivity,saturation_slope;
 // Signed departure T-Tsat(p) on the requested branch (zero at an endpoint).
 double saturation_departure;
};
// The complete forward point under one admission (see water_direction_at).
static int water_point_at(int branch,double p,double T,OperatingWaterPoint* out,int admit) noexcept {
 if(!out) return 2;
 try {
  State q;double ts;
  const int status=branch_state<CompleteTuple>(branch,p,T,q,ts,admit);if(status)return status;
  const double slope=saturation_slope(p);
  require(std::isfinite(slope)&&slope>0,"Invalid saturation derivative");
  *out={q.region,q.p,q.T,q.rho,q.u,q.h,q.cp,q.cv,q.alpha,q.kappa,q.mu,q.conductivity,slope,q.T-ts};
  return 0;
 }catch(const std::domain_error&){return 1;}
 catch(const std::exception&){return 3;}
 catch(...){return 3;}
}
int ld01_water_point(int branch,double p,double T,OperatingWaterPoint* out) noexcept {
 return water_point_at(branch,p,T,out,ADMIT_ANY);
}
// The same branches, checks and status codes as ld01_water_point. Fields it
// does not evaluate (cv, kappa, mu, conductivity, saturation slope) are NaN.
int ld01_water_caloric(int branch,double p,double T,OperatingWaterPoint* out) noexcept {
 if(!out) return 2;
 try {
  State q;double ts;
  const int status=branch_state<CaloricTuple>(branch,p,T,q,ts,ADMIT_ANY);if(status)return status;
  const double none=std::numeric_limits<double>::quiet_NaN();
  *out={q.region,q.p,q.T,q.rho,q.u,q.h,q.cp,none,q.alpha,none,none,none,none,q.T-ts};
  return 0;
 }catch(const std::domain_error&){return 1;}
 catch(const std::exception&){return 3;}
 catch(...){return 3;}
}
// Thermodynamic rho/u/h tangents use Gibbs identities. Upstream does not expose
// third/transport derivatives: cp/alpha/kappa/mu/k use same-branch, second-order
// local coefficient probes. These are disclosed inexact Newton coefficients,
// never a replacement EOS value or a finite-difference whole-plant Jacobian.
// Direction at q, which is ld01_water_point(branch,p,T)'s own complete output.
// Coefficient probes stay with the centre's admission: a stable-side centre
// is probed on stable-side states only, as before metastable admission; a
// metastable centre inside its own band range, and an Eq. (18) centre on its
// metastable side only, so that no probe mixes two equations.
static int water_direction_at(int branch,double p,double T,double dp,double dT,
 const OperatingWaterPoint& q,OperatingWaterPoint* direction) noexcept {
 int admit=ADMIT_STABLE;
 try{
  if(metastable_side(branch,p,T,r4.T_p(p))){
   const int k=band_range(p);
   if(k>=0)admit=branch==1&&band_ranges[k].vapor_equation==18?ONLY_METASTABLE+k:k;
  }
 }catch(...){return 3;}
 const bool saturated=branch==2||branch==3;
 const double actual_dT=saturated?q.saturation_slope*dp:dT;
 OperatingWaterPoint d{};d.region=q.region;d.p=dp;d.T=actual_dT;
 d.saturation_departure=actual_dT-q.saturation_slope*dp;
 d.rho=q.rho*(q.kappa*dp-q.alpha*actual_dT);
 d.u=(p*q.kappa-q.T*q.alpha)/q.rho*dp+(q.cp-p*q.alpha/q.rho)*actual_dT;
 d.h=(1-q.T*q.alpha)/q.rho*dp+q.cp*actual_dT;
 const double scale=std::max(std::abs(dp)/p,saturated?0.:std::abs(dT)/q.T);
 if(scale!=0.) {
  const double h=std::cbrt(std::numeric_limits<double>::epsilon())/scale;
  OperatingWaterPoint a{},b{},c{};
  const bool plus=water_point_at(branch,p+h*dp,T+h*dT,&a,admit)==0;
  const bool minus=water_point_at(branch,p-h*dp,T-h*dT,&b,admit)==0;
  int side=0;
  if(!(plus&&minus)){
   side=plus?1:minus?-1:0;
   if(!side||water_point_at(branch,p+2*side*h*dp,T+2*side*h*dT,&c,admit))return 1;
  }
  const auto coefficient=[&](double OperatingWaterPoint::*member){
   if(plus&&minus)return (a.*member-b.*member)/(2*h);
   const auto& first=side==1?a:b;
   return side*(-3*(q.*member)+4*(first.*member)-(c.*member))/(2*h);
  };
  d.cp=coefficient(&OperatingWaterPoint::cp);d.cv=coefficient(&OperatingWaterPoint::cv);
  d.alpha=coefficient(&OperatingWaterPoint::alpha);d.kappa=coefficient(&OperatingWaterPoint::kappa);
  d.mu=coefficient(&OperatingWaterPoint::mu);d.conductivity=coefficient(&OperatingWaterPoint::conductivity);
  d.saturation_slope=coefficient(&OperatingWaterPoint::saturation_slope);
 }
 const std::array<double,12> fields{{d.p,d.T,d.rho,d.u,d.h,d.cp,d.cv,d.alpha,d.kappa,d.mu,d.conductivity,d.saturation_slope}};
 if(!std::all_of(fields.begin(),fields.end(),[](double v){return std::isfinite(v);}))return 3;
 *direction=d;return 0;
}
int ld01_water_direction(int branch,double p,double T,double dp,double dT,
 OperatingWaterPoint* out,OperatingWaterPoint* direction) noexcept {
 if(!out||!direction||!std::isfinite(dp)||!std::isfinite(dT))return 2;
 OperatingWaterPoint q{},d{};
 int status=ld01_water_point(branch,p,T,&q);if(status)return status;
 status=water_direction_at(branch,p,T,dp,dT,q,&d);if(status)return status;
 *out=q;*direction=d;return 0;
}
// The same direction at a point the caller already holds: held must be the
// complete output of ld01_water_point(branch,held->p,held->T), which is then
// not evaluated a second time. Only the probes are evaluated here.
int ld01_water_direction_held(int branch,const OperatingWaterPoint* held,double dp,double dT,
 OperatingWaterPoint* direction) noexcept {
 if(!held||!direction||!std::isfinite(dp)||!std::isfinite(dT))return 2;
 OperatingWaterPoint d{};
 const int status=water_direction_at(branch,held->p,held->T,dp,dT,*held,&d);if(status)return status;
 *direction=d;return 0;
}
// The caloric inverse's branch ends at p: the stable end (branch code and
// temperature: the saturated endpoint, or region 1 at its temperature limit
// where saturation lies above it); the trial end of the metastable band, NaN
// where the branch has none at p; and the branch code of the metastable
// bracket's saturation end (the stable end itself on a continuous equation,
// METASTABLE_SATURATED_VAPOR on Eq. 18). Branches 0 and 1 only.
int ld01_water_bracket(int branch,double p,int* stable_branch,double* stable_T,double* trial_T,
 int* saturation_branch) noexcept {
 if(!stable_branch||!stable_T||!trial_T||!saturation_branch||(branch!=0&&branch!=1))return 2;
 try {
  require(std::isfinite(p)&&p>=1e5&&p<=(branch==0?liquid_ceiling_pa:vapor_ceiling_pa),
   "Operating water pressure domain");
  const double ts=r4.T_p(p),none=std::numeric_limits<double>::quiet_NaN();
  const int k=band_range(p);
  if(branch==0){
   const bool saturated=ts<=IF97::T23min;
   *stable_branch=saturated?2:0;*stable_T=saturated?0.:liquid_temperature_max_k;
   *trial_T=k>=0&&ts<liquid_temperature_max_k?std::min(ts+trial_max_k,liquid_temperature_max_k):none;
   *saturation_branch=*stable_branch;
  }else{
   *stable_branch=3;*stable_T=0.;
   *trial_T=k>=0?ts-trial_max_k:none;
   *saturation_branch=k>=0&&band_ranges[k].vapor_equation==18?METASTABLE_SATURATED_VAPOR:3;
  }
  return 0;
 }catch(const std::domain_error&){return 1;}
 catch(...){return 3;}
}
struct OperatingBandRange {
 double low,high,liquid_superheat_max,vapor_subcooling_max;
 int low_exclusive,vapor_equation;
};
struct OperatingMetastableBand {
 double trial_max,credited_max,liquid_temperature_max,liquid_ceiling,vapor_ceiling;
 int range_count;
 OperatingBandRange ranges[2];
};
static_assert(band_range_count>=1&&band_range_count<=2,"one or two band ranges");
int ld01_water_metastable_band(OperatingMetastableBand* out) noexcept {
 if(!out)return 2;
 *out={trial_max_k,credited_max_k,liquid_temperature_max_k,liquid_ceiling_pa,vapor_ceiling_pa,band_range_count,{}};
 for(int k=0;k<band_range_count;++k){
  const BandRange& r=band_ranges[k];
  out->ranges[k]={r.low_pa,r.high_pa,r.liquid_superheat_max_k,r.vapor_subcooling_max_k,r.low_exclusive?1:0,r.vapor_equation};
 }
 return 0;
}
// The bare Eq. (18) tuple v,h,u,s,cp,w at (T,p) with no admission, for
// verification against IF97 Table 18 only; never a property query.
int ld01_water_eq18_reference(double T,double p,double* out) noexcept {
 if(!out||!std::isfinite(T)||!std::isfinite(p)||T<=0||p<=0)return 2;
 try{
  const State q=gibbs(r2m,2,T,p);
  const double v[6]={1/q.rho,q.h,q.u,q.s,q.cp,q.w};
  std::copy(v,v+6,out);return 0;
 }catch(const std::domain_error&){return 1;}
 catch(...){return 3;}
}
int ld01_water_surface(double T,double dT,double* value,double* direction) noexcept {
 if(!value||!direction||!std::isfinite(T)||!std::isfinite(dT))return 2;
 try {
  const double q=IF97::sigma97(T);
  double d=0.;
  if(dT!=0.){
   const double h=std::cbrt(std::numeric_limits<double>::epsilon())*T;
   d=(IF97::sigma97(T+h)-IF97::sigma97(T-h))/(2*h)*dT;
  }
  if(!std::isfinite(q)||!std::isfinite(d))return 3;
  *value=q;*direction=d;return 0;
 }catch(...){return 1;}
}
int ld01_water_vapor_sat_density(double T,double dT,double* value,double* direction) noexcept {
 if(!value||!direction||!std::isfinite(T)||!std::isfinite(dT))return 2;
 try {
  const double p=r4.p_T(T),dp=dT/saturation_slope(p);
  OperatingWaterPoint q{},d{};
  const int status=ld01_water_direction(3,p,T,dp,dT,&q,&d);if(status)return status;
  *value=q.rho;*direction=d.rho;return 0;
 }catch(...){return 1;}
}
}
`

export async function buildOperatingWater(if97Directory:string,wikiRoot:string,outputDirectory:string){
  const directory=resolve(if97Directory),output=resolve(outputDirectory),wiki=resolve(wikiRoot)
  const [header,license]=await Promise.all(['IF97.h','LICENSE'].map(n=>Bun.file(join(directory,n)).bytes()))
  if(hash(header!)!==nativeIf97HeaderSha256||hash(license!)!==nativeIf97LicenseSha256)
    throw Error('Pinned maintained IF97 header/license mismatch')
  const page=await Bun.file(join(wiki,metastableBandPage)).bytes()
  const block=ownedBlock(new TextDecoder().decode(page),pzrOwners.metastable.heading,pzrOwners.metastable.fence)
  const band=parseMetastableBand(block)
  const source=operatingWaterBridge(band)
  await mkdir(output,{recursive:true})
  const work=await mkdtemp(join(tmpdir(),'ld01-water-build-'))
  try{
    const object=join(work,'water.o'),library=join(output,'libld01_operating_water.a')
    const compile=Bun.spawn(['c++','-std=c++17','-O2','-fPIC','-I',directory,'-x','c++','-c','-o',object,'-'],
      {stdin:new Blob([source]),stdout:'pipe',stderr:'pipe'})
    const [compileError,code]=await Promise.all([new Response(compile.stderr).text(),compile.exited])
    if(code!==0)throw Error(compileError||'Operating water bridge compilation failed')
    const archive=Bun.spawn(['ar','rcs',library,object],{stdout:'pipe',stderr:'pipe'})
    const [archiveError,status]=await Promise.all([new Response(archive.stderr).text(),archive.exited])
    if(status!==0)throw Error(archiveError||'Operating water archive failed')
    // Written by this hash-verified build for inspection. Cargo links the
    // explicitly supplied artifact directory; it is a trusted local build
    // input, not a separate cryptographic artifact-admission service.
    const receipt={revision:nativeIf97Revision,headerSha256:nativeIf97HeaderSha256,
      licenseSha256:nativeIf97LicenseSha256,adapterSha256:hash(source),
      librarySha256:hash(await Bun.file(library).bytes()),platform:process.platform,architecture:process.arch,
      metastableBand:{page:metastableBandPage,pageSha256:hash(page),heading:pzrOwners.metastable.heading,
        fence:pzrOwners.metastable.fence,block,band}}
    await Bun.write(join(output,'water-build.json'),JSON.stringify(receipt,null,2)+'\n')
    return {directory:output,...receipt}
  }finally{await rm(work,{recursive:true,force:true})}
}

if(import.meta.main){
  const [if97,wiki,output,...rest]=Bun.argv.slice(2)
  if(!if97||!wiki||!output||rest.length)
    throw Error('Usage: operating-water <pinned IF97 directory> <wiki root> <artifact directory>')
  console.log(JSON.stringify(await buildOperatingWater(if97,wiki,output)))
}
