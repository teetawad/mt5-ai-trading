// MT5 AI Demo Trading Lab session bridge.
// Compile and run from MetaTrader 5 to export broker-provided symbol sessions.
// Output: Terminal Common Files\mt5-session-bridge.json
#property script_show_inputs

input string OutputFileName = "mt5-session-bridge.json";
input bool SelectedSymbolsOnly = false;

string JsonEscape(const string value)
{
   string output = value;
   StringReplace(output, "\\", "\\\\");
   StringReplace(output, "\"", "\\\"");
   return output;
}

void AppendSessionRows(
   int handle,
   const string symbol,
   const ENUM_DAY_OF_WEEK day,
   const bool trade,
   bool &first
)
{
   datetime from_time;
   datetime to_time;
   int index = 0;
   while(index < 32)
   {
      bool ok = trade
         ? SymbolInfoSessionTrade(symbol, day, index, from_time, to_time)
         : SymbolInfoSessionQuote(symbol, day, index, from_time, to_time);
      if(!ok)
         break;
      if(!first)
         FileWriteString(handle, ",");
      first = false;
      FileWriteString(
         handle,
         StringFormat(
            "{\"day\":%d,\"open_seconds\":%d,\"close_seconds\":%d}",
            (int)day,
            (int)from_time,
            (int)to_time
         )
      );
      index++;
   }
}

void OnStart()
{
   int handle = FileOpen(OutputFileName, FILE_WRITE | FILE_TXT | FILE_COMMON | FILE_ANSI);
   if(handle == INVALID_HANDLE)
   {
      Print("Failed to open session bridge output: ", GetLastError());
      return;
   }

   FileWriteString(handle, "{");
   FileWriteString(handle, StringFormat("\"server_time\":%I64d,", (long)TimeTradeServer()));
   FileWriteString(handle, "\"symbols\":{");

   int total = SymbolsTotal(SelectedSymbolsOnly);
   bool first_symbol = true;
   for(int i = 0; i < total; i++)
   {
      string symbol = SymbolName(i, SelectedSymbolsOnly);
      if(symbol == "")
         continue;
      if(!first_symbol)
         FileWriteString(handle, ",");
      first_symbol = false;

      FileWriteString(handle, "\"" + JsonEscape(symbol) + "\":{");
      FileWriteString(handle, "\"trade_sessions\":[");
      bool first_session = true;
      for(int day = SUNDAY; day <= SATURDAY; day++)
      {
         AppendSessionRows(handle, symbol, (ENUM_DAY_OF_WEEK)day, true, first_session);
      }
      FileWriteString(handle, "],\"quote_sessions\":[");
      first_session = true;
      for(int day = SUNDAY; day <= SATURDAY; day++)
      {
         AppendSessionRows(handle, symbol, (ENUM_DAY_OF_WEEK)day, false, first_session);
      }
      FileWriteString(handle, "]}");
   }

   FileWriteString(handle, "}}");
   FileClose(handle);
   Print("MT5 session bridge exported to Common Files\\", OutputFileName);
}
