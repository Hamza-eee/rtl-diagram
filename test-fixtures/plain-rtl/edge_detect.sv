module edge_detect (
    input  logic clk,
    input  logic sig,
    output logic rise
);
  logic prev;
  always_ff @(posedge clk) prev <= sig;
  assign rise = sig & ~prev;
endmodule
