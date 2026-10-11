/* Original narrow glue to stock IDA/KLU; no solver algorithm is copied here. */
#include <ida/ida.h>
#include <ida/ida_ls.h>
#include <nvector/nvector_serial.h>
#include <sunmatrix/sunmatrix_sparse.h>
#include <sunlinsol/sunlinsol_klu.h>
#include <klu.h>
#include <sundials/sundials_config.h>
#include <sundials/sundials_version.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#if SUNDIALS_VERSION_MAJOR != 7 || SUNDIALS_VERSION_MINOR != 5
#error "Admit a changed stock SUNDIALS version explicitly before using it"
#endif
#if KLU_MAIN_VERSION != 2 || KLU_SUB_VERSION != 3 || KLU_SUBSUB_VERSION != 6
#error "Admit a changed stock KLU version explicitly before using it"
#endif
_Static_assert(sizeof(sunrealtype) == sizeof(double), "DOUBLE required");
_Static_assert(sizeof(sunindextype) == sizeof(int64_t), "INT64 required");
typedef int (*Residual)(void*, double, const double*, const double*, double*);
typedef int (*Jacobian)(void*, double, double, const double*, const double*, double*, int64_t*, int64_t*);
typedef int (*Roots)(void*, double, const double*, const double*, double*);
typedef struct {
    SUNContext ctx;
    N_Vector y, yp, atol, ids;
    SUNMatrix matrix;
    SUNLinearSolver linear;
    void *ida, *user;
    Residual residual;
    Jacobian jacobian;
    Roots roots;
    double time;
} OperatingIDA;
static int residual(double t, N_Vector y, N_Vector yp, N_Vector r, void *v) {
    OperatingIDA *o = v;
    return o->residual(o->user,t,N_VGetArrayPointer(y),N_VGetArrayPointer(yp),N_VGetArrayPointer(r));
}
static int jacobian(double t, double cj, N_Vector y, N_Vector yp, N_Vector r,
                    SUNMatrix j, void *v, N_Vector a, N_Vector b, N_Vector c) {
    (void)r; (void)a; (void)b; (void)c;
    OperatingIDA *o = v;
    return o->jacobian(o->user,t,cj,N_VGetArrayPointer(y),N_VGetArrayPointer(yp),
        SUNSparseMatrix_Data(j),SUNSparseMatrix_IndexValues(j),SUNSparseMatrix_IndexPointers(j));
}
static int root_values(double t, N_Vector y, N_Vector yp, double *g, void *v) {
    OperatingIDA *o = v;
    return o->roots(o->user,t,N_VGetArrayPointer(y),N_VGetArrayPointer(yp),g);
}
void operating_ida_free(OperatingIDA *o) {
    if (!o) return;
    if (o->ida) IDAFree(&o->ida);
    if (o->linear) SUNLinSolFree(o->linear);
    if (o->matrix) SUNMatDestroy(o->matrix);
    if (o->ids) N_VDestroy(o->ids);
    if (o->atol) N_VDestroy(o->atol);
    if (o->yp) N_VDestroy(o->yp);
    if (o->y) N_VDestroy(o->y);
    if (o->ctx) SUNContext_Free(&o->ctx);
    free(o);
}
OperatingIDA *operating_ida_create(int64_t n,int64_t nnz,double t,double rtol,
    const double *atol,const double *ids,const double *y,const double *yp,
    Residual f,Jacobian j,int nroots,Roots g,void *user,int *status) {
    OperatingIDA *o = calloc(1,sizeof(*o));
    *status=-1;
    if (!o) return NULL;
    int major=0,minor=0,patch=0; char label[64];
    if (SUNDIALSGetVersionNumber(&major,&minor,&patch,label,sizeof(label))
        || major!=SUNDIALS_VERSION_MAJOR || minor!=SUNDIALS_VERSION_MINOR
        || patch!=SUNDIALS_VERSION_PATCH) goto fail;
    o->user=user; o->residual=f; o->jacobian=j; o->roots=g; o->time=t;
    if (SUNContext_Create(SUN_COMM_NULL,&o->ctx)) goto fail;
    o->y=N_VNew_Serial(n,o->ctx); o->yp=N_VNew_Serial(n,o->ctx);
    o->atol=N_VNew_Serial(n,o->ctx); o->ids=N_VNew_Serial(n,o->ctx);
    if (!o->y || !o->yp || !o->atol || !o->ids) goto fail;
    memcpy(N_VGetArrayPointer(o->y),y,n*sizeof(double));
    memcpy(N_VGetArrayPointer(o->yp),yp,n*sizeof(double));
    memcpy(N_VGetArrayPointer(o->atol),atol,n*sizeof(double));
    memcpy(N_VGetArrayPointer(o->ids),ids,n*sizeof(double));
    o->matrix=SUNSparseMatrix(n,n,nnz,CSC_MAT,o->ctx);
    if (!o->matrix) goto fail;
    o->linear=SUNLinSol_KLU(o->y,o->matrix,o->ctx);
    o->ida=IDACreate(o->ctx);
    if (!o->linear || !o->ida) goto fail;
#define CHECK(call) do { *status=(call); if (*status<0) goto fail; } while(0)
    CHECK(IDAInit(o->ida,residual,t,o->y,o->yp));
    CHECK(IDASetUserData(o->ida,o));
    CHECK(IDASVtolerances(o->ida,rtol,o->atol));
    CHECK(IDASetId(o->ida,o->ids));
    CHECK(IDASetLinearSolver(o->ida,o->linear,o->matrix));
    CHECK(IDASetJacFn(o->ida,jacobian));
    if (nroots>0) CHECK(IDARootInit(o->ida,nroots,root_values));
    return o;
fail: operating_ida_free(o); return NULL;
}
int operating_ida_initialize(OperatingIDA *o,double horizon,double *y,double *yp) {
    int code=IDACalcIC(o->ida,IDA_YA_YDP_INIT,horizon);
    if (code>=0) code=IDAGetConsistentIC(o->ida,o->y,o->yp);
    if (code>=0) {
        memcpy(y,N_VGetArrayPointer(o->y),N_VGetLength(o->y)*sizeof(double));
        memcpy(yp,N_VGetArrayPointer(o->yp),N_VGetLength(o->yp)*sizeof(double));
    }
    return code;
}
int operating_ida_advance(OperatingIDA *o,double target,double *time,double *y,double *yp) {
    int code=IDASolve(o->ida,target,&o->time,o->y,o->yp,IDA_NORMAL);
    *time=o->time;
    if (code>=0) {
        memcpy(y,N_VGetArrayPointer(o->y),N_VGetLength(o->y)*sizeof(double));
        memcpy(yp,N_VGetArrayPointer(o->yp),N_VGetLength(o->yp)*sizeof(double));
    }
    return code;
}
int operating_ida_stop_at(OperatingIDA *o,double target) { return IDASetStopTime(o->ida,target); }
int operating_ida_nonnegative(OperatingIDA *o,const double *flags) {
    if (!flags) return IDASetConstraints(o->ida,NULL);
    N_Vector constraints=N_VClone(o->y);
    if (!constraints) return IDA_MEM_FAIL;
    memcpy(N_VGetArrayPointer(constraints),flags,N_VGetLength(o->y)*sizeof(double));
    /* Stock IDASetConstraints retains its own copy, not this temporary vector. */
    int code=IDASetConstraints(o->ida,constraints);
    N_VDestroy(constraints);
    return code;
}
int operating_ida_current_time(OperatingIDA *o,double *t) { return IDAGetCurrentTime(o->ida,t); }
int operating_ida_current_state(OperatingIDA *o,double *time,double *y,double *yp) {
    double current;
    int code=IDAGetCurrentTime(o->ida,&current);
    if (code<0) return code;
    /* CurrentY/Yp alias the IDASolve output buffers, which may have been
       interpolated to tout. Evaluate history at tn into independent scratch. */
    N_Vector state=N_VClone(o->y), rate=N_VClone(o->yp);
    if (!state || !rate) {
        if (state) N_VDestroy(state);
        if (rate) N_VDestroy(rate);
        return IDA_MEM_FAIL;
    }
    code=IDAGetDky(o->ida,current,0,state);
    if (code>=0) code=IDAGetDky(o->ida,current,1,rate);
    if (code>=0) {
        memcpy(y,N_VGetArrayPointer(state),N_VGetLength(state)*sizeof(double));
        memcpy(yp,N_VGetArrayPointer(rate),N_VGetLength(rate)*sizeof(double));
        *time=current;
    }
    N_VDestroy(rate);
    N_VDestroy(state);
    return code;
}
int operating_ida_error_diagnostics(OperatingIDA *o,double *errors,double *weights,int *order) {
    N_Vector e=N_VClone(o->y), w=N_VClone(o->y);
    if (!e || !w) {
        if (e) N_VDestroy(e);
        if (w) N_VDestroy(w);
        return IDA_MEM_FAIL;
    }
    int code=IDAGetEstLocalErrors(o->ida,e);
    if (code>=0) code=IDAGetErrWeights(o->ida,w);
    if (code>=0) code=IDAGetCurrentOrder(o->ida,order);
    if (code>=0) {
        memcpy(errors,N_VGetArrayPointer(e),N_VGetLength(e)*sizeof(double));
        memcpy(weights,N_VGetArrayPointer(w),N_VGetLength(w)*sizeof(double));
    }
    N_VDestroy(w);
    N_VDestroy(e);
    return code;
}
int operating_ida_stats(OperatingIDA *o,long *counts,int *orders,double *steps) {
    int code=IDAGetNumSteps(o->ida,&counts[0]);
    if (code>=0) code=IDAGetNumResEvals(o->ida,&counts[1]);
    if (code>=0) code=IDAGetNumJacEvals(o->ida,&counts[2]);
    if (code>=0) code=IDAGetNumNonlinSolvIters(o->ida,&counts[3]);
    if (code>=0) code=IDAGetNumErrTestFails(o->ida,&counts[4]);
    if (code>=0) code=IDAGetNumNonlinSolvConvFails(o->ida,&counts[5]);
    if (code>=0) code=IDAGetNumLinSolvSetups(o->ida,&counts[6]);
    if (code>=0) code=IDAGetNumGEvals(o->ida,&counts[7]);
    if (code>=0) code=IDAGetLastOrder(o->ida,&orders[0]);
    if (code>=0) code=IDAGetCurrentOrder(o->ida,&orders[1]);
    if (code>=0) code=IDAGetLastStep(o->ida,&steps[0]);
    if (code>=0) code=IDAGetCurrentStep(o->ida,&steps[1]);
    return code;
}
int operating_ida_max_order(OperatingIDA *o,int order) { return IDASetMaxOrd(o->ida,order); }
int operating_ida_max_step(OperatingIDA *o,double step) { return IDASetMaxStep(o->ida,step); }
/* Stock IDASetInitStep: the first step; it persists across IDAReInit. */
int operating_ida_init_step(OperatingIDA *o,double step) { return IDASetInitStep(o->ida,step); }
int operating_ida_solution_scaling(OperatingIDA *o,int enabled) {
    return IDASetLinearSolutionScaling(o->ida,enabled?SUNTRUE:SUNFALSE);
}
int operating_ida_newton_coefficient(OperatingIDA *o,double coefficient) {
    return IDASetNonlinConvCoef(o->ida,coefficient);
}
/* Stock IDAReInit restarts history at t from (y,yp); tolerances, ids,
   constraints, roots, linear solver, Jacobian, stop time and options stay. */
int operating_ida_reinitialize(OperatingIDA *o,double t,const double *y,const double *yp) {
    memcpy(N_VGetArrayPointer(o->y),y,N_VGetLength(o->y)*sizeof(double));
    memcpy(N_VGetArrayPointer(o->yp),yp,N_VGetLength(o->yp)*sizeof(double));
    int code=IDAReInit(o->ida,t,o->y,o->yp);
    if (code>=0) o->time=t;
    return code;
}
int operating_ida_root_directions(OperatingIDA *o,int *directions) {
    return IDAGetRootInfo(o->ida,directions);
}
/* Stock IDASetId copies the vector; the owned ids remain only its source. */
int operating_ida_differential(OperatingIDA *o,const double *ids) {
    memcpy(N_VGetArrayPointer(o->ids),ids,N_VGetLength(o->ids)*sizeof(double));
    return IDASetId(o->ida,o->ids);
}

/* Direct stock KLU (64-bit klu_l) on one fixed CSC pattern. Rust validates
   every pattern/value/buffer before these calls; KLU keeps no caller pointer.
   A failed factorization leaves no Numeric, so nothing solves with it. */
typedef struct {
    klu_l_common common;
    klu_l_symbolic *symbolic;
    klu_l_numeric *numeric;
} OperatingKLU;
#define OPERATING_KLU_VERSION (-100)
void operating_klu_free(OperatingKLU *k) {
    if (!k) return;
    if (k->numeric) klu_l_free_numeric(&k->numeric,&k->common);
    if (k->symbolic) klu_l_free_symbolic(&k->symbolic,&k->common);
    free(k);
}
OperatingKLU *operating_klu_analyze(int64_t n,int64_t *pointers,int64_t *rows,int *status,int *loaded) {
    klu_version(loaded);
    if (loaded[0]!=KLU_MAIN_VERSION || loaded[1]!=KLU_SUB_VERSION || loaded[2]!=KLU_SUBSUB_VERSION) {
        *status=OPERATING_KLU_VERSION;
        return NULL;
    }
    OperatingKLU *k=calloc(1,sizeof(*k));
    if (!k) { *status=KLU_OUT_OF_MEMORY; return NULL; }
    if (!klu_l_defaults(&k->common)) { *status=k->common.status; free(k); return NULL; }
    k->symbolic=klu_l_analyze(n,pointers,rows,&k->common);
    *status=k->common.status;
    if (!k->symbolic || *status!=KLU_OK) { operating_klu_free(k); return NULL; }
    return k;
}
/* Keep Numeric only for a complete nonsingular factorization. */
static int operating_klu_settle(OperatingKLU *k,int succeeded,int64_t *singular) {
    int status=k->common.status;
    *singular=k->common.singular_col;
    if (succeeded && status==KLU_OK && k->numeric) return KLU_OK;
    if (k->numeric) klu_l_free_numeric(&k->numeric,&k->common);
    return status==KLU_OK ? KLU_INVALID : status;
}
int operating_klu_factor(OperatingKLU *k,int64_t *pointers,int64_t *rows,double *values,int64_t *singular) {
    if (k->numeric) klu_l_free_numeric(&k->numeric,&k->common);
    k->numeric=klu_l_factor(pointers,rows,values,k->symbolic,&k->common);
    return operating_klu_settle(k,k->numeric!=NULL,singular);
}
int operating_klu_refactor(OperatingKLU *k,int64_t *pointers,int64_t *rows,double *values,int64_t *singular) {
    int succeeded=klu_l_refactor(pointers,rows,values,k->symbolic,k->numeric,&k->common);
    return operating_klu_settle(k,succeeded,singular);
}
int operating_klu_solve(OperatingKLU *k,int64_t n,double *rhs) {
    int succeeded=klu_l_solve(k->symbolic,k->numeric,n,1,rhs,&k->common);
    return succeeded && k->common.status==KLU_OK ? KLU_OK
        : (k->common.status==KLU_OK ? KLU_INVALID : k->common.status);
}
int operating_klu_rcond(OperatingKLU *k,double *rcond) {
    int succeeded=klu_l_rcond(k->symbolic,k->numeric,&k->common);
    *rcond=k->common.rcond;
    return succeeded && k->common.status==KLU_OK ? KLU_OK
        : (k->common.status==KLU_OK ? KLU_INVALID : k->common.status);
}
