/** Build the opt-in narrow native IF97 boundary. This is a build artifact, not
 * a second equation-of-state implementation or an application dependency. */
import {createHash} from 'node:crypto'
import {mkdir, mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {nativeIf97HeaderSha256, nativeIf97LicenseSha256, nativeIf97Revision, nativeIf97Source} from './reference-design-if97-primitives'

const hash=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex')

// One authored adapter is shared with the existing forward preparation reader.
// C++ exceptions never cross the C ABI; output is written only on success.
export const operatingWaterBridge=String.raw`
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
extern "C" {
struct OperatingWaterPoint {
 int region;
 double p,T,rho,u,h,cp,cv,alpha,kappa,mu,conductivity,saturation_slope;
};
int ld01_water_point(int branch,double p,double T,OperatingWaterPoint* out) noexcept {
 if(!out) return 2;
 try {
  require(std::isfinite(p)&&p>=1e5&&p<=16e6,"Operating water pressure domain");
  State q;
  switch(branch) {
   // An exact saturation boundary has two physical branches. Honour the
   // explicit caller branch instead of delegating its identity to TP rounding.
   case 0:q=T==r4.T_p(p)?endpoint(p,true):liquid(T,p);break;
   case 1:q=T==r4.T_p(p)?endpoint(p,false):vapor(T,p);break;
   case 2:q=endpoint(p,true);break;
   case 3:q=endpoint(p,false);break;
   default:return 2;
  }
  require(q.region==1||q.region==2,"Operating water admits R1/R2 only");
  const double slope=saturation_slope(p);
  require(std::isfinite(slope)&&slope>0,"Invalid saturation derivative");
  *out={q.region,q.p,q.T,q.rho,q.u,q.h,q.cp,q.cv,q.alpha,q.kappa,q.mu,q.conductivity,slope};
  return 0;
 }catch(const std::domain_error&){return 1;}
 catch(const std::exception&){return 3;}
 catch(...){return 3;}
}
// The same branches, checks and status codes as ld01_water_point. Fields it
// does not evaluate (cv, kappa, mu, conductivity, saturation slope) are NaN.
int ld01_water_caloric(int branch,double p,double T,OperatingWaterPoint* out) noexcept {
 if(!out) return 2;
 try {
  require(std::isfinite(p)&&p>=1e5&&p<=16e6,"Operating water pressure domain");
  State q;
  switch(branch) {
   case 0:q=T==r4.T_p(p)?endpoint_caloric(p,true):liquid_caloric(T,p);break;
   case 1:q=T==r4.T_p(p)?endpoint_caloric(p,false):vapor_caloric(T,p);break;
   case 2:q=endpoint_caloric(p,true);break;
   case 3:q=endpoint_caloric(p,false);break;
   default:return 2;
  }
  require(q.region==1||q.region==2,"Operating water admits R1/R2 only");
  const double none=std::numeric_limits<double>::quiet_NaN();
  *out={q.region,q.p,q.T,q.rho,q.u,q.h,q.cp,none,q.alpha,none,none,none,none};
  return 0;
 }catch(const std::domain_error&){return 1;}
 catch(const std::exception&){return 3;}
 catch(...){return 3;}
}
// Thermodynamic rho/u/h tangents use Gibbs identities. Upstream does not expose
// third/transport derivatives: cp/alpha/kappa/mu/k use same-branch, second-order
// local coefficient probes. These are disclosed inexact Newton coefficients,
// never a replacement EOS value or a finite-difference whole-plant Jacobian.
int ld01_water_direction(int branch,double p,double T,double dp,double dT,
 OperatingWaterPoint* out,OperatingWaterPoint* direction) noexcept {
 if(!out||!direction||!std::isfinite(dp)||!std::isfinite(dT))return 2;
 OperatingWaterPoint q{};
 const int status=ld01_water_point(branch,p,T,&q);if(status)return status;
 const bool saturated=branch==2||branch==3;
 const double actual_dT=saturated?q.saturation_slope*dp:dT;
 OperatingWaterPoint d{};d.region=q.region;d.p=dp;d.T=actual_dT;
 d.rho=q.rho*(q.kappa*dp-q.alpha*actual_dT);
 d.u=(p*q.kappa-q.T*q.alpha)/q.rho*dp+(q.cp-p*q.alpha/q.rho)*actual_dT;
 d.h=(1-q.T*q.alpha)/q.rho*dp+q.cp*actual_dT;
 const double scale=std::max(std::abs(dp)/p,saturated?0.:std::abs(dT)/q.T);
 if(scale!=0.) {
  const double h=std::cbrt(std::numeric_limits<double>::epsilon())/scale;
  OperatingWaterPoint a{},b{},c{};
  const bool plus=ld01_water_point(branch,p+h*dp,T+h*dT,&a)==0;
  const bool minus=ld01_water_point(branch,p-h*dp,T-h*dT,&b)==0;
  int side=0;
  if(!(plus&&minus)){
   side=plus?1:minus?-1:0;
   if(!side||ld01_water_point(branch,p+2*side*h*dp,T+2*side*h*dT,&c))return 1;
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
 *out=q;*direction=d;return 0;
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

export async function buildOperatingWater(if97Directory:string,outputDirectory:string){
  const directory=resolve(if97Directory),output=resolve(outputDirectory)
  const [header,license]=await Promise.all(['IF97.h','LICENSE'].map(n=>Bun.file(join(directory,n)).bytes()))
  if(hash(header!)!==nativeIf97HeaderSha256||hash(license!)!==nativeIf97LicenseSha256)
    throw Error('Pinned maintained IF97 header/license mismatch')
  await mkdir(output,{recursive:true})
  const work=await mkdtemp(join(tmpdir(),'ld01-water-build-'))
  try{
    const object=join(work,'water.o'),library=join(output,'libld01_operating_water.a')
    const compile=Bun.spawn(['c++','-std=c++17','-O2','-fPIC','-I',directory,'-x','c++','-c','-o',object,'-'],
      {stdin:new Blob([operatingWaterBridge]),stdout:'pipe',stderr:'pipe'})
    const [compileError,code]=await Promise.all([new Response(compile.stderr).text(),compile.exited])
    if(code!==0)throw Error(compileError||'Operating water bridge compilation failed')
    const archive=Bun.spawn(['ar','rcs',library,object],{stdout:'pipe',stderr:'pipe'})
    const [archiveError,status]=await Promise.all([new Response(archive.stderr).text(),archive.exited])
    if(status!==0)throw Error(archiveError||'Operating water archive failed')
    // Written by this hash-verified build for inspection. Cargo links the
    // explicitly supplied artifact directory; it is a trusted local build
    // input, not a separate cryptographic artifact-admission service.
    const receipt={revision:nativeIf97Revision,headerSha256:nativeIf97HeaderSha256,
      licenseSha256:nativeIf97LicenseSha256,adapterSha256:hash(operatingWaterBridge),
      librarySha256:hash(await Bun.file(library).bytes()),platform:process.platform,architecture:process.arch}
    await Bun.write(join(output,'water-build.json'),JSON.stringify(receipt,null,2)+'\n')
    return {directory:output,...receipt}
  }finally{await rm(work,{recursive:true,force:true})}
}

if(import.meta.main){
  const [if97,output,...rest]=Bun.argv.slice(2)
  if(!if97||!output||rest.length)throw Error('Usage: operating-water <pinned IF97 directory> <artifact directory>')
  console.log(JSON.stringify(await buildOperatingWater(if97,output)))
}
