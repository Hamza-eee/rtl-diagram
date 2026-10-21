// One down-counting timer channel.
module timer_core
  import soc_pkg::*;
#(
    parameter int W = 16
) (
    input  logic         clk,
    input  logic         rst_n,
    input  logic         tick,
    input  mode_t        mode,
    input  logic [W-1:0] load,
    output logic [W-1:0] count,
    output logic         expired
);
  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      count   <= '0;
      expired <= 1'b0;
    end else begin
      expired <= 1'b0;
      if (mode == MODE_OFF) count <= load;
      else if (tick) begin
        if (count == '0) begin
          expired <= 1'b1;
          count   <= (mode == MODE_PERIODIC) ? load : '0;
        end else begin
          count <= count - 1'b1;
        end
      end
    end
  end
endmodule
