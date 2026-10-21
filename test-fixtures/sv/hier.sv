// Synthetic hierarchy for path-resolution and marker tests. Not real design code.

module leafh (
    input  logic a,
    output logic q
);
  assign q = a;
endmodule

module hier_top #(
    parameter bit USE_A = 1'b1
) (
    input  logic       a,
    output logic [3:0] q,
    output logic       r,
    output logic       s,
    output logic       t
);
  for (genvar i = 0; i < 2; i++) begin : g_ch
    leafh u_f (.a(a), .q(q[i]));
  end

  leafh u_arr[1:0] (.a(a), .q(q[3:2]));

  if (USE_A) begin : g_a
    leafh u_x (.a(a), .q(r));
  end else begin : g_b
    leafh u_x (.a(a), .q(r));
  end

  if (1) begin
    leafh u_y (.a(a), .q(s));
  end

  leafh u_tx (.a(a), .q(t));
  leafh u_rx (.a(a), .q());
endmodule

// The DUT instantiated once (unique path) and twice (ambiguous).
module wrap_once (input logic a);
  hier_top u_dut (.a(a), .q(), .r(), .s(), .t());
endmodule

module wrap_twice (input logic a);
  hier_top u_d0 (.a(a), .q(), .r(), .s(), .t());
  hier_top u_d1 (.a(a), .q(), .r(), .s(), .t());
endmodule
