// Testbench top. Excluded from the diagram by the default rtlDiagram.exclude globs.
module tb;
  logic clk = 0, rst_n = 0;
  soc_top dut (.clk_i(clk), .rst_ni(rst_n), .psel_i(1'b0), .penable_i(1'b0), .pwrite_i(1'b0),
               .paddr_i('0), .pwdata_i('0), .prdata_o(), .pready_o(), .ext_evt_i(1'b0), .evt_level_o(), .irq_o());
  always #5 clk = ~clk;
endmodule
