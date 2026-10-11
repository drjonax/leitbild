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
/** One band over its whole pressure range (owner decision request 3, H3):
 * region-1 Eq. (7) for liquid and region-2 Eq. (15) for vapor, on both sides
 * of saturation. Below 10 MPa IF97 supplies Eq. (18) for metastable vapor; H3
 * selects Eq. (15) there too, so the bridge has one vapor equation and no
 * pressure at which the vapor branch switches equations. */
export type MetastableBand={pressureRange_Pa:[number,number],lowerBoundExclusive:boolean,
  liquidSuperheatMax_K:number,vaporSubcoolingMax_K:number,trialMax_K:number,creditedMax_K:number,
  liquidTemperatureMax_K:number,liquidPressureCeiling_Pa:number,vaporPressureCeiling_Pa:number}

/** The compilers' strict block: its exact field set, refusing anything else, never defaulted. */
export function parseMetastableBand(value:unknown):MetastableBand{
  return metastableSchema.parse(value)
}

// One authored adapter is shared with the existing forward preparation reader.
// C++ exceptions never cross the C ABI; output is written only on success.
export const operatingWaterBridge=(band:MetastableBand)=>String.raw`
#include <algorithm>
#include <cmath>
#include <limits>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <utility>
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
// One pass over a region's residual terms. upstream's members evaluate each
// Gibbs derivative as its own loop, and the tuple's fields call them again and
// again (umass, hmass, rhomass and alpha re-evaluate dgammar_dPI and
// dgammar_dTAU; cvmass, drhodp and tcond re-evaluate them and cpmass). Here
// each residual sum of BaseRegion::dgammar_dPI, dgammar_dTAU, d2gammar_dTAU2,
// d2gammar_dPIdTAU and d2gammar_dPI2 is accumulated once, term by term in the
// same order with the same per-term expression, every integer power evaluated
// once per term by upstream's powi and shared by the sums that read it. The
// fields then use upstream's own expressions (BaseRegion::rhomass, umass,
// hmass, cpmass, cvmass, drhodp and lambda2, Region1's cvmass and drhodp, the
// shared Gibbs::alpha) on these sums and the upstream ideal-gas members, so
// every field is the same value bit for bit.
constexpr int FIELD_CV=1,FIELD_KAPPA=2,FIELD_MU=4,FIELD_K=8,FIELD_SLOPE=16,FIELDS_ALL=31;
constexpr int SUM_PI=1,SUM_TAU=2,SUM_TAUTAU=4,SUM_PITAU=8,SUM_PIPI=16;
struct GibbsSums {double pi=0,tau=0,tautau=0,pitau=0,pipi=0;};
template<class R> struct FusedGibbs : R {
 template<int S> GibbsSums sums(double T,double p) const {
  const double _PI=this->PIrterm(p),_TAU=this->TAUrterm(T);
  GibbsSums s;
  for(std::size_t i=0;i<this->Jr.size();++i){
   const double n=this->nr[i];const int I=this->Ir[i],J=this->Jr[i];
   const double pi_i=(S&(SUM_TAU|SUM_TAUTAU))?IF97::powi(_PI,I):0.;
   const double pi_i1=(S&(SUM_PI|SUM_PITAU))?IF97::powi(_PI,I-1):0.;
   const double tau_j=(S&(SUM_PI|SUM_PIPI))?IF97::powi(_TAU,J):0.;
   const double tau_j1=(S&(SUM_TAU|SUM_PITAU))?IF97::powi(_TAU,J-1):0.;
   if constexpr((S&SUM_PI)!=0) s.pi+=n*I*pi_i1*tau_j;
   if constexpr((S&SUM_TAU)!=0) s.tau+=n*J*pi_i*tau_j1;
   if constexpr((S&SUM_TAUTAU)!=0) s.tautau+=n*J*(J-1)*pi_i*IF97::powi(_TAU,J-2);
   if constexpr((S&SUM_PITAU)!=0) s.pitau+=n*J*I*pi_i1*tau_j1;
   if constexpr((S&SUM_PIPI)!=0) s.pipi+=n*I*(I-1)*IF97::powi(_PI,I-2)*tau_j;
  }
  return s;
 }
 // rho, u, h, cp and alpha; the other fields NaN.
 State caloric(int region,double T,double p) const {
  const double none=std::numeric_limits<double>::quiet_NaN();
  const GibbsSums s=sums<SUM_PI|SUM_TAU|SUM_TAUTAU|SUM_PITAU>(T,p);
  const double gp=this->dgamma0_dPI(T,p)+s.pi;
  const double gt=this->dgamma0_dTAU(T,p)+s.tau;
  const double gtt=s.tautau+this->d2gamma0_dTAU2(T,p);
  const double gpt=s.pitau;
  const double tau=this->T_star/T,PI=p/this->p_star;
  const double rho=this->p_star/(this->R*T)/(IF97::p_fact/1000.0/IF97::R_fact)/gp;
  const double u=this->R*T*(tau*gt-PI*gp);
  const double h=this->R*this->T_star*gt;
  const double cp=-this->R*tau*tau*gtt;
  const double alpha=(gp-this->T_star/T*gpt)/(T*gp);
  const State q{region,p,T,rho,u,h,none,cp,none,none,alpha,none,none,none};
  const std::array<double,7> fields{{q.p,q.T,q.rho,q.u,q.h,q.cp,q.alpha}};
  require(std::all_of(fields.begin(),fields.end(),[](double value){return std::isfinite(value);}),
   "Nonfinite field in returned native tuple");
  return q;
 }
 // drhodp: Region1's override, or BaseRegion's (rho is rhomass's value).
 double drhodp_of(const GibbsSums& s,double T,double p,double rho) const {
  if constexpr(std::is_same_v<R,IF97::Region1>)
   return -s.pipi/(IF97::powi(s.pi,2)*this->R*T)*(1000*IF97::R_fact/IF97::p_fact);
  else {
   const double PI=p/this->p_star;
   return (rho/p)*((1.0-PI*PI*s.pipi)/(1.0+PI*s.pi));
  }
 }
 // cvmass: Region1's override, or BaseRegion's (cp is cpmass's value).
 double cv_of(const GibbsSums& s,double T,double p,double cp) const {
  if constexpr(std::is_same_v<R,IF97::Region1>){
   const double tau=this->T_star/T;
   return this->R*(-tau*tau*s.tautau+IF97::powi(s.pi-tau*s.pitau,2)/s.pipi);
  }else{
   const double tau=this->T_star/T,PI=p/this->p_star;
   return cp-this->R*IF97::powi(1+PI*s.pi-tau*PI*s.pitau,2)/(1-PI*PI*s.pipi);
  }
 }
 // BaseRegion::lambda2 on the same cpmass, cvmass, visc and drhodp values.
 double lambda2_of(double T,double rho,double cp,double cv,double mu,double drhodp) const {
  double y,Cpbar,mubar,k,Z,delChi;
  const double rhobar=rho/IF97::Rhocrit;
  const double LAMBDA=177.8514;
  const double qD=1.0/0.40;
  const double Tr=1.5*IF97::Tcrit;
  const double xi0=0.13;
  const double nu=0.630;
  const double gam=1.239;
  const double GAMMA0=0.06;
  const double PI=3.141592654;
  const double Cpstar=0.46151805*IF97::R_fact;
  Cpbar=cp/Cpstar;
  if((Cpbar<0)||(Cpbar>1.0E13)) Cpbar=1.0E13;
  k=cp/cv;
  mubar=mu/1.0E-6;
  delChi=rhobar*(IF97::Pcrit/IF97::Rhocrit*drhodp-this->delTr(rho)*Tr/T);
  if(delChi>0) y=qD*xi0*std::pow(delChi/GAMMA0,nu/gam);
  else y=0.0;
  if(y<1.2E-7) Z=0.0;
  else Z=2.0/PI/y*(((1.0-1.0/k)*atan(y)+y/k)-(1.0-exp(-1.0/(1.0/y+y*y/(3.0*rhobar*rhobar)))));
  return LAMBDA*rhobar*Cpbar*T/(IF97::Tcrit*mubar)*Z;
 }
 // The requested fields of gibbs()'s tuple beyond the caloric state q at its
 // own (T,p): r.cvmass, r.drhodp/rho, r.visc and r.tcond (BaseRegion::tcond).
 void complete(State& q,int fields) const {
  const double T=q.T,p=q.p,rho=q.rho;
  if(fields&(FIELD_CV|FIELD_K)){
   const GibbsSums s=sums<SUM_PI|SUM_TAUTAU|SUM_PITAU|SUM_PIPI>(T,p);
   const double cv=cv_of(s,T,p,q.cp),drhodp=drhodp_of(s,T,p,rho),mu=this->visc(T,rho);
   if(fields&FIELD_CV) q.cv=cv;
   if(fields&FIELD_KAPPA) q.kappa=drhodp/rho;
   if(fields&FIELD_MU) q.mu=mu;
   if(fields&FIELD_K){
    const double lambda_star=0.001;
    const double lambda_bar=this->lambda0(T)*this->lambda1(T,rho)+lambda2_of(T,rho,q.cp,cv,mu,drhodp);
    q.conductivity=lambda_star*lambda_bar;
   }
  }else{
   if(fields&FIELD_KAPPA) q.kappa=drhodp_of(sums<SUM_PI|SUM_PIPI>(T,p),T,p,rho)/rho;
   if(fields&FIELD_MU) q.mu=this->visc(T,rho);
  }
 }
};
static const FusedGibbs<IF97::Region1> c1;
static const FusedGibbs<IF97::Region2> c2;
// Complete the requested fields of an admitted (region 1 or 2) caloric state,
// refusing a non-finite one as gibbs()'s tuple check does; the saturation
// slope is water_point_at's, with its check. Unrequested fields stay NaN.
double complete_state(State& q,int fields) {
 switch(q.region){
  case 1:c1.complete(q,fields);break;
  case 2:c2.complete(q,fields);break;
  default:throw std::invalid_argument("Completion of a non-R1/R2 state");
 }
 const std::array<std::pair<int,double>,4> added{{{FIELD_CV,q.cv},{FIELD_KAPPA,q.kappa},{FIELD_MU,q.mu},{FIELD_K,q.conductivity}}};
 require(std::all_of(added.begin(),added.end(),[&](const auto& f){return !(fields&f.first)||std::isfinite(f.second);}),
  "Nonfinite field in returned native tuple");
 if(!(fields&FIELD_SLOPE))return std::numeric_limits<double>::quiet_NaN();
 const double slope=saturation_slope(q.p);
 require(std::isfinite(slope)&&slope>0,"Invalid saturation derivative");
 return slope;
}
State point_caloric(double T,double p) {
 if (!std::isfinite(T)||!std::isfinite(p)||p<=0||T<=0)
  throw std::domain_error("Invalid finite positive PT input");
 switch(IF97::RegionDetermination_TP(T,p)) {
  case IF97::REGION_1: return c1.caloric(1,T,p);
  case IF97::REGION_2: return c2.caloric(2,T,p);
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
 if(T<=IF97::T23min) return is_liquid?c1.caloric(1,T,p):c2.caloric(2,T,p);
 return endpoint(p,is_liquid);
}
// Bounded metastable admission: the parsed ld01-metastable-band block, recorded
// with its page hash in the build receipt.
constexpr double band_pressure_low_pa=${band.pressureRange_Pa[0]},band_pressure_high_pa=${band.pressureRange_Pa[1]};
constexpr bool band_lower_exclusive=${band.lowerBoundExclusive};
constexpr double trial_max_k=${band.trialMax_K},liquid_temperature_max_k=${band.liquidTemperatureMax_K};
constexpr double liquid_ceiling_pa=${band.liquidPressureCeiling_Pa},vapor_ceiling_pa=${band.vaporPressureCeiling_Pa};
constexpr double liquid_superheat_max_k=${band.liquidSuperheatMax_K},vapor_subcooling_max_k=${band.vaporSubcoolingMax_K};
constexpr double credited_max_k=${band.creditedMax_K};
constexpr int TRIAL_BAND=4;
bool in_band(double p) {
 return (band_lower_exclusive?p>band_pressure_low_pa:p>=band_pressure_low_pa)&&p<=band_pressure_high_pa;
}
// The metastable side of saturation on an explicit branch: liquid above Tsat;
// vapor below it where the shared adapter's own supersaturation test refuses
// (every vapor state that test admits keeps its unchanged stable path).
bool metastable_side(int branch,double p,double T,double ts) {
 return (branch==0&&T>ts)||(branch==1&&T<ts&&T>=IF97::Tmin&&!(p<=r4.p_T(T)));
}
// The caloric state on the shared adapter's branch paths; ld01_water_point
// completes it (complete_state) rather than evaluating gibbs()'s tuple.
struct CaloricTuple {
 static State liquid_equation(double T,double p){return c1.caloric(1,T,p);}
 static State vapor_equation(double T,double p){return c2.caloric(2,T,p);}
 static State stable_liquid(double T,double p){return liquid_caloric(T,p);}
 static State stable_vapor(double T,double p){return vapor_caloric(T,p);}
 static State saturated(double p,bool is_liquid){return endpoint_caloric(p,is_liquid);}
};
// The explicitly requested branch at (p,T); ts is Tsat(p). An exact saturation
// boundary has two physical branches: honour the caller's branch instead of
// delegating its identity to TP rounding. The stable side of saturation and the
// saturated endpoints take the shared adapter's unchanged paths. With
// metastable admission, the metastable side is the branch's own basic
// equation, region-1 Eq. (7) or region-2 Eq. (15), inside the band's pressure
// range and trial departure only: no region search and no backward equation.
// Outside them it returns TRIAL_BAND. Without admission it is the stable path.
template<class Tuple> int branch_state(int branch,double p,double T,State& q,double& ts,bool metastable) {
 require(std::isfinite(p)&&p>=1e5&&p<=(branch==0||branch==2?liquid_ceiling_pa:vapor_ceiling_pa),
  "Operating water pressure domain");
 ts=r4.T_p(p);
 if(metastable&&metastable_side(branch,p,T,ts)){
  const bool liquid=branch==0;
  if(!(in_band(p)&&(liquid?T<=std::min(ts+trial_max_k,liquid_temperature_max_k):T>=ts-trial_max_k)))
   return TRIAL_BAND;
  q=liquid?Tuple::liquid_equation(T,p):Tuple::vapor_equation(T,p);
 }else switch(branch) {
  case 0:
   if(T==ts){q=Tuple::saturated(p,true);break;}
   require(!(T>liquid_temperature_max_k),"Liquid above the region-1 temperature limit");
   q=Tuple::stable_liquid(T,p);break;
  case 1:q=T==ts?Tuple::saturated(p,false):Tuple::stable_vapor(T,p);break;
  case 2:q=Tuple::saturated(p,true);break;
  case 3:q=Tuple::saturated(p,false);break;
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
// The complete forward point; metastable admission is off only for the
// coefficient probes of a stable-side state (see water_direction_at). It is the
// caloric state completed with every remaining field: gibbs()'s tuple without
// entropy and sound speed, which no returned tuple carries, with the same
// branch, domain and region checks and status codes.
static int water_point_at(int branch,double p,double T,OperatingWaterPoint* out,bool metastable) noexcept {
 if(!out) return 2;
 try {
  State q;double ts;
  const int status=branch_state<CaloricTuple>(branch,p,T,q,ts,metastable);if(status)return status;
  const double slope=complete_state(q,FIELDS_ALL);
  *out={q.region,q.p,q.T,q.rho,q.u,q.h,q.cp,q.cv,q.alpha,q.kappa,q.mu,q.conductivity,slope,q.T-ts};
  return 0;
 }catch(const std::domain_error&){return 1;}
 catch(const std::exception&){return 3;}
 catch(...){return 3;}
}
int ld01_water_point(int branch,double p,double T,OperatingWaterPoint* out) noexcept {
 return water_point_at(branch,p,T,out,true);
}
// The same branches, checks and status codes as ld01_water_point. Fields it
// does not evaluate (cv, kappa, mu, conductivity, saturation slope) are NaN.
int ld01_water_caloric(int branch,double p,double T,OperatingWaterPoint* out) noexcept {
 if(!out) return 2;
 try {
  State q;double ts;
  const int status=branch_state<CaloricTuple>(branch,p,T,q,ts,true);if(status)return status;
  const double none=std::numeric_limits<double>::quiet_NaN();
  *out={q.region,q.p,q.T,q.rho,q.u,q.h,q.cp,none,q.alpha,none,none,none,none,q.T-ts};
  return 0;
 }catch(const std::domain_error&){return 1;}
 catch(const std::exception&){return 3;}
 catch(...){return 3;}
}
// ld01_water_point's tuple, restricted to the requested FIELD_* bits, from the
// caloric state that ld01_water_caloric returned for the SAME (branch,p,T):
// that state already holds region, p, T, rho, u, h, cp, alpha and departure bit
// for bit, so only the requested cv, kappa, viscosity, conductivity and
// saturation slope are added (complete_state); unrequested fields are NaN.
int ld01_water_complete(const OperatingWaterPoint* caloric,int fields,OperatingWaterPoint* out) noexcept {
 if(!caloric||!out||fields<0||fields>FIELDS_ALL||(caloric->region!=1&&caloric->region!=2))return 2;
 try {
  const OperatingWaterPoint& c=*caloric;
  const double none=std::numeric_limits<double>::quiet_NaN();
  State q{c.region,c.p,c.T,c.rho,c.u,c.h,none,c.cp,none,none,c.alpha,none,none,none};
  const double slope=complete_state(q,fields);
  *out={q.region,q.p,q.T,q.rho,q.u,q.h,q.cp,q.cv,q.alpha,q.kappa,q.mu,q.conductivity,slope,c.saturation_departure};
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
// is probed on stable-side states only, as before metastable admission, and a
// metastable centre inside the band.
static int water_direction_at(int branch,double p,double T,double dp,double dT,
 const OperatingWaterPoint& q,OperatingWaterPoint* direction) noexcept {
 bool metastable;
 try{metastable=metastable_side(branch,p,T,r4.T_p(p));}catch(...){return 3;}
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
  const bool plus=water_point_at(branch,p+h*dp,T+h*dT,&a,metastable)==0;
  const bool minus=water_point_at(branch,p-h*dp,T-h*dT,&b,metastable)==0;
  int side=0;
  if(!(plus&&minus)){
   side=plus?1:minus?-1:0;
   if(!side||water_point_at(branch,p+2*side*h*dp,T+2*side*h*dT,&c,metastable))return 1;
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
// where saturation lies above it) and the trial end of the metastable band,
// NaN where the branch has no band at p. Branches 0 and 1 only.
int ld01_water_bracket(int branch,double p,int* stable_branch,double* stable_T,double* trial_T) noexcept {
 if(!stable_branch||!stable_T||!trial_T||(branch!=0&&branch!=1))return 2;
 try {
  require(std::isfinite(p)&&p>=1e5&&p<=(branch==0?liquid_ceiling_pa:vapor_ceiling_pa),
   "Operating water pressure domain");
  const double ts=r4.T_p(p),none=std::numeric_limits<double>::quiet_NaN();
  if(branch==0){
   const bool saturated=ts<=IF97::T23min;
   *stable_branch=saturated?2:0;*stable_T=saturated?0.:liquid_temperature_max_k;
   *trial_T=in_band(p)&&ts<liquid_temperature_max_k?std::min(ts+trial_max_k,liquid_temperature_max_k):none;
  }else{
   *stable_branch=3;*stable_T=0.;
   *trial_T=in_band(p)?ts-trial_max_k:none;
  }
  return 0;
 }catch(const std::domain_error&){return 1;}
 catch(...){return 3;}
}
struct OperatingMetastableBand {
 double pressure_low,pressure_high,trial_max,liquid_superheat_max,vapor_subcooling_max,
  credited_max,liquid_temperature_max,liquid_ceiling,vapor_ceiling;
 int lower_exclusive;
};
int ld01_water_metastable_band(OperatingMetastableBand* out) noexcept {
 if(!out)return 2;
 *out={band_pressure_low_pa,band_pressure_high_pa,trial_max_k,liquid_superheat_max_k,
  vapor_subcooling_max_k,credited_max_k,liquid_temperature_max_k,liquid_ceiling_pa,vapor_ceiling_pa,
  band_lower_exclusive?1:0};
 return 0;
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
  const band=parseMetastableBand(ownedBlock(new TextDecoder().decode(page),pzrOwners.metastable.heading,pzrOwners.metastable.fence))
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
        fence:pzrOwners.metastable.fence,band}}
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
