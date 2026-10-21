// No Bender.yml here: found through the include glob or files.f.
module blinky (
    input  logic       clk,
    input  logic       rst,
    input  logic       button,
    output logic [3:0] leds
);
  logic press;
  edge_detect u_edge (.clk(clk), .sig(button), .rise(press));
  counter #(4) u_cnt (clk, rst, press, leds);
endmodule
