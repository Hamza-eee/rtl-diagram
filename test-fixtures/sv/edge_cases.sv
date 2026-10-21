// Synthetic SystemVerilog covering constructs the extractor must handle.
// Not real design code; used only by the unit tests.

module leaf #(
    parameter int W = 4,
    parameter     D = 2, E = 3
) (
    input  logic         clk,
    input  logic [W-1:0] a, b,
    output logic [W-1:0] y,
    inout  wire          pad
);
  localparam int L = W * 2;
  logic [L-1:0] tmp;
  assign tmp = {a, b};
  always_ff @(posedge clk) y <= a + b;
endmodule

// Non-ANSI header: directions in the body
module old_style (clk, rst_n, d, q);
  input clk, rst_n;
  input [7:0] d;
  output reg [7:0] q;
  always @(posedge clk or negedge rst_n)
    if (!rst_n) q <= 8'd0;
    else q <= d;
endmodule

module top #(parameter N = 2) (
    input  logic       clk,
    input  logic       rst_n,
    input  logic [3:0] a,
    input  logic [3:0] b,
    output logic [3:0] y,
    output logic [7:0] q,
    output logic [3:0] yy [N]
);
  logic [7:0] d;
  wire pad;
  logic clk2 = clk;

  // named connections, one using .name shorthand
  leaf #(.W(4)) u_leaf (.clk, .a(a), .b(b[3:0]), .y(y), .pad(pad));

  // positional connections
  old_style u_old (clk, rst_n, d, q);

  // wildcard
  leaf u_wild (.*, .pad());

  assign d = {a, b};

  genvar i;
  generate
    for (i = 0; i < N; i++) begin : g_leaf
      leaf #(.W(4)) u_g (.clk(clk), .a(a), .b(b), .y(yy[i]), .pad());
    end
    if (N > 1) begin : g_extra
      old_style u_cond (.clk(clk), .rst_n(rst_n), .d(d), .q());
    end
  endgenerate

  always_comb begin
    {y[0], y[1]} = 2'b00;
  end
endmodule
