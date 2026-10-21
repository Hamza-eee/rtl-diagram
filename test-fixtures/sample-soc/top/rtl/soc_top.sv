// Sample SoC: APB-programmed timers, an external event counter and one interrupt.
module soc_top #(
    parameter int NUM_TIMERS = 2
) (
    input  logic        clk_i,
    input  logic        rst_ni,
    // APB
    input  logic        psel_i,
    input  logic        penable_i,
    input  logic        pwrite_i,
    input  logic [7:0]  paddr_i,
    input  logic [31:0] pwdata_i,
    output logic [31:0] prdata_o,
    output logic        pready_o,
    // External event (asynchronous)
    input  logic        ext_evt_i,
    output logic [7:0]  evt_level_o,
    // Interrupt
    output logic        irq_o
);
  logic [7:0]            div;
  logic [NUM_TIMERS-1:0] irq_en;
  soc_pkg::mode_t        mode  [NUM_TIMERS];
  logic [15:0]           load  [NUM_TIMERS];
  logic [15:0]           count [NUM_TIMERS];
  logic [NUM_TIMERS-1:0] expired;
  logic                  evt_s, evt_q;
  logic                  fifo_full, fifo_empty;

  sync_2ff u_sync (
      .clk  (clk_i),
      .rst_n(rst_ni),
      .d    (ext_evt_i),
      .q    (evt_s)
  );

  regs #(.N(NUM_TIMERS), .W(16)) u_regs (
      .pclk   (clk_i),
      .presetn(rst_ni),
      .psel   (psel_i),
      .penable(penable_i),
      .pwrite (pwrite_i),
      .paddr  (paddr_i),
      .pwdata (pwdata_i),
      .prdata (prdata_o),
      .pready (pready_o),
      .div    (div),
      .irq_en (irq_en),
      .mode   (mode),
      .load   (load),
      .count  (count)
  );

  timer #(.N(NUM_TIMERS), .W(16)) u_timer (
      .clk    (clk_i),
      .rst_n  (rst_ni),
      .div    (div),
      .mode   (mode),
      .load   (load),
      .count  (count),
      .expired(expired)
  );

  fifo #(.W(8), .D(4)) u_evt_fifo (
      .clk  (clk_i),
      .rst_n(rst_ni),
      .push (evt_s & ~evt_q),
      .pop  (1'b0),
      .wdata(count[0][7:0]),
      .rdata(evt_level_o),
      .full (fifo_full),
      .empty()
  );

  always_ff @(posedge clk_i or negedge rst_ni) begin
    if (!rst_ni) evt_q <= 1'b0;
    else evt_q <= evt_s;
  end

  assign irq_o = |(expired & irq_en);
endmodule
