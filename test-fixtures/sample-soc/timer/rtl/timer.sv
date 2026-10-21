// N timer channels sharing one prescaler.
module timer #(
    parameter int N = 2,
    parameter int W = 16
) (
    input  logic            clk,
    input  logic            rst_n,
    input  logic [7:0]      div,
    input  soc_pkg::mode_t  mode    [N],
    input  logic [W-1:0]    load    [N],
    output logic [W-1:0]    count   [N],
    output logic [N-1:0]    expired
);
  logic tick;

  prescaler #(.W(8)) u_pre (
      .clk,
      .rst_n,
      .div,
      .tick
  );

  for (genvar i = 0; i < N; i++) begin : g_ch
    timer_core #(.W(W)) u_core (
        .clk    (clk),
        .rst_n  (rst_n),
        .tick   (tick),
        .mode   (mode[i]),
        .load   (load[i]),
        .count  (count[i]),
        .expired(expired[i])
    );
  end
endmodule
