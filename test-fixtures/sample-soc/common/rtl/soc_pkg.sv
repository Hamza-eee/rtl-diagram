// Shared types for the sample SoC.
package soc_pkg;
  typedef enum logic [1:0] {
    MODE_OFF      = 2'd0,
    MODE_ONESHOT  = 2'd1,
    MODE_PERIODIC = 2'd2
  } mode_t;
endpackage
