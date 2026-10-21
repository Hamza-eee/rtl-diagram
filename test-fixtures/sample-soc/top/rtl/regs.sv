// APB register block for the timers.
//   0x00 DIV   0x04 IRQ_EN   0x10+8n MODE[n]   0x14+8n LOAD[n]   0x40+4n COUNT[n] (read-only)
module regs
  import soc_pkg::*;
#(
    parameter int N = 2,
    parameter int W = 16
) (
    input  logic          pclk,
    input  logic          presetn,
    input  logic          psel,
    input  logic          penable,
    input  logic          pwrite,
    input  logic [7:0]    paddr,
    input  logic [31:0]   pwdata,
    output logic [31:0]   prdata,
    output logic          pready,
    output logic [7:0]    div,
    output logic [N-1:0]  irq_en,
    output mode_t         mode  [N],
    output logic [W-1:0]  load  [N],
    input  logic [W-1:0]  count [N]
);
  wire wr = psel && penable && pwrite;

  always_ff @(posedge pclk or negedge presetn) begin
    if (!presetn) begin
      div    <= '0;
      irq_en <= '0;
      for (int n = 0; n < N; n++) begin
        mode[n] <= MODE_OFF;
        load[n] <= '0;
      end
    end else if (wr) begin
      if (paddr == 8'h00) div <= pwdata[7:0];
      if (paddr == 8'h04) irq_en <= pwdata[N-1:0];
      for (int n = 0; n < N; n++) begin
        if (paddr == 8'h10 + 8 * n) mode[n] <= mode_t'(pwdata[1:0]);
        if (paddr == 8'h14 + 8 * n) load[n] <= pwdata[W-1:0];
      end
    end
  end

  always_comb begin
    prdata = '0;
    if (paddr == 8'h00) prdata = {24'd0, div};
    if (paddr == 8'h04) prdata = {{(32 - N){1'b0}}, irq_en};
    for (int n = 0; n < N; n++) if (paddr == 8'h40 + 4 * n) prdata = {{(32 - W){1'b0}}, count[n]};
  end

  assign pready = 1'b1;
endmodule
