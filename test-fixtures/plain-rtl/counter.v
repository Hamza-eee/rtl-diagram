// Verilog-2001, non-ANSI header.
module counter (clk, rst, en, q);
  parameter WIDTH = 4;
  input clk, rst, en;
  output reg [WIDTH-1:0] q;
  always @(posedge clk)
    if (rst) q <= 0;
    else if (en) q <= q + 1;
endmodule
