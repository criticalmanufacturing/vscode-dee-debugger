using Mono.Cecil;
using Mono.Cecil.Cil;

// Patch DebugInformationFormat.Pdb -> PortablePdb in the DEE Compiler's EmitOptions call.
// The format enum is argument #1 of the 15-arg ctor: it is the ldc.i4.1 that directly
// follows ldc.i4.0 (metadataOnly=false) and directly precedes the pdbFilePath ldloc.
// Usage: patcher <dll> [--patch <outputDll>]
var doPatch = args.Length >= 3 && args[1] == "--patch";
var module = ModuleDefinition.ReadModule(args[0]);
var compiler = module.GetTypes().First(t => t.FullName == "Cmf.Foundation.Common.DynamicExecutionEngine.Compiler");
int patched = 0;
foreach (var method in compiler.Methods.Where(m => m.HasBody))
{
    var il = method.Body.Instructions;
    for (int i = 2; i < il.Count; i++)
    {
        if (il[i].OpCode.Code == Code.Newobj && il[i].Operand is MethodReference ctor &&
            ctor.DeclaringType.FullName == "Microsoft.CodeAnalysis.Emit.EmitOptions")
        {
            for (int j = i - 25 < 0 ? 2 : i - 25; j < i; j++)
            {
                bool isFormatArg = il[j].OpCode.Code == Code.Ldc_I4_1 &&
                                   il[j - 1].OpCode.Code == Code.Ldc_I4_0 &&
                                   (il[j + 1].OpCode.Code is Code.Ldloc or Code.Ldloc_S
                                     or Code.Ldloc_0 or Code.Ldloc_1 or Code.Ldloc_2 or Code.Ldloc_3);
                bool isAlready = il[j].OpCode.Code == Code.Ldc_I4_2 && il[j - 1].OpCode.Code == Code.Ldc_I4_0;
                if (isFormatArg)
                {
                    Console.WriteLine($"{method.Name}: [{j}] debugInformationFormat = Pdb(1) <-- target");
                    if (doPatch) { il[j].OpCode = OpCodes.Ldc_I4_2; patched++; Console.WriteLine($"  PATCHED [{j}] -> PortablePdb(2)"); }
                }
                else if (isAlready)
                {
                    Console.WriteLine($"{method.Name}: [{j}] already PortablePdb(2)");
                }
            }
        }
    }
}
Console.WriteLine($"patched={patched}");
if (doPatch && patched > 0) { module.Write(args[2]); Console.WriteLine($"written: {args[2]}"); }
return patched > 0 || !doPatch ? 0 : 1;
