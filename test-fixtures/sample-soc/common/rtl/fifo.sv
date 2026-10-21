// Small synchronous FIFO.
module fifo #(
    parameter int W = 8,
    parameter int D = 4
) (
    input  logic         clk,
    input  logic         rst_n,
    input  logic         push,
    input  logic         pop,
    input  logic [W-1:0] wdata,
    output logic [W-1:0] rdata,
    output logic         full,
    output logic         empty
);
  localparam int AW = $clog2(D);

  logic [W-1:0] mem [D];
  logic [AW:0]  wptr, rptr;

  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      wptr <= '0;
      rptr <= '0;
    end else begin
      if (push && !full) begin
        mem[wptr[AW-1:0]] <= wdata;
        wptr <= wptr + 1'b1;
      end
      if (pop && !empty) rptr <= rptr + 1'b1;
    end
  end

  assign rdata = mem[rptr[AW-1:0]];
  assign empty = (wptr == rptr);
  assign full  = (wptr[AW-1:0] == rptr[AW-1:0]) && (wptr[AW] != rptr[AW]);
endmodule
