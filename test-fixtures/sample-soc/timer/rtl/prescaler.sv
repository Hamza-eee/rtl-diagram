// Divides the clock into a one-cycle tick every (div + 1) cycles.
module prescaler #(
    parameter int W = 8
) (
    input  logic         clk,
    input  logic         rst_n,
    input  logic [W-1:0] div,
    output logic         tick
);
  logic [W-1:0] cnt;

  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) cnt <= '0;
    else if (cnt == div) cnt <= '0;
    else cnt <= cnt + 1'b1;
  end

  assign tick = (cnt == div);
endmodule
