import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// Character content is loaded verbatim from the user-supplied ascii-art.txt.
const PORTRAIT: readonly string[] = [
	"##########*###########################################################################+*############",
	"############+#########################################################+=**+#########################",
	"#############**######################*#######**#*++++++++*+*####*+=*#*****##########################",
	"################*#*##########=++++**###*#===++**+++++++******##=++****#***#*#######*################",
	"#############################=++**+++++++##=+****++*+****+++*****#*+******#*#########****###########",
	"##################+*#*#====+*=++***++++**********#****+**********#*#**#***#*##+**###################",
	"###################*+##=+++====**+*****++*++****++*#+*************####***###**#*####################",
	"###############*######+++++=*+=++*****++++*+**++****++#+*********##*+**#*###+#******+*##############",
	"####################==++++=+#++=*=++***+*****+****+*#**+#*******+++****#####+#*****##***+###########",
	"################++++*+++*=+**#+++*=+++++***+*********+###*+*+++++*+****##**#+##******######+########",
	"###*##########*+##*+++**==+*+*#+*+*=**++*+****++#*******#****+*******#****#####*#*****+#############",
	"#############*##*=+==+*+=++*+**++*+****++**********#**#**+##+******#*****##**#*##*****+**###########",
	"###########+####==++*++==++*+*###**#*****++***********#*#**#*#**##*****+#####**#**#*****+*##########",
	"##########*####++++=++=++**+*##++#+**#+*******#*******#####**#*******###*####*#*#********+##########",
	"##############+#+++*+++++**+**#+*+##+*+#+******#***********##***#####*#*###*#****#*******++##*######",
	"#############+#++***#++++*+*#++**+++++**##*#*****###****#-+#++#*##**#*##*##*##****#*******+#########",
	"#############+#+*+**##+*+*+***#+###++==*+++**++#**####***##+##+#****###*###*+#*******#****+#########",
	"###############*+**####+**++**####====+++++++#++++#***+*#*#+++#+#*#*###**##**#*****#*#****+#########",
	"################+**###***+*++*+*+#*=++++++*++++*+++#*#+***##++*+######***##*********#*#***+#########",
	"################+**###*#**+=*+*+++++++++++++++++++#+#++++*++**+#######***#+**+#*******#***+#########",
	"##########*##*###**###*####-*+*++--++++++++++++++++*+++#*#+*+#######*##**#+**+#+*******#****########",
	"#################+*#####*-+++++=:#+++++++++++++++++*+++++++*###########**#****#+*******#*****#######",
	"##################*##-++++++++++++++++++++++++++++++++++++#####*#####*#*#*****#*+******##**#########",
	"#######################++++++++++++++++++++++++++++++#####*#**#######***#+****#*+*******#**##*######",
	"##########################++++++++++++++++++++++++++#***++*#+#+###*###*##+**#*#********+#*######*###",
	"##########################-+++++++++++++++++++++++++#+++++***+##*#####*#++****#**+*****+############",
	"###########################+*+++++++++++++++++++++*++++++++*+#****###**#+*****#**********###########",
	"############################-+++++++++++++++++++#+++++++++++**#*#####+#++*****#****#******##*#######",
	"##############################-++++++++++++++++++++++++++++++*#*#####*++******#***********##*#######",
	"##############################*++++++++++++++++++++++++++++++*#######*++******#*****#*****+#*#######",
	"##########################*####-+++++++++++++*+++++++++++++++**#####*+++#+****#*************########",
	"#########################*#####==++++*+++####++++++++++*******#######+*#++****#****#*#******#*######",
	"###########################################**#--+++##**##########*##++#+*+****#*****#*##*****#######",
	"###########################################=#+##*******####*****+#*#+*#**+***###*******#******######",
	"########################################*#-##******##****#********#+#+#**+**####********#*****######",
	"#########################################++#+**#*+********#*******+##*###++***##*****#**##****######",
	"###################**###################++#+#+*#=*****#***********+##*###+++**###*****#**##****#####",
	"################**######################+++#*#+#+**#*###***#******++######+++#*##*****#***##*#*#####",
	"#############*+########################*++#+##=*****#*###****#******#**#####++####****#*#**##***##*#",
	"###########+##########################+++*+#*##**********#**#*#*##**++*####*#**###****####**##**####",
	"#########################*########*++*++++*#+##+**+*******#***==+*********#**##*###***####***##*####",
	"################################*++*++*#+*##*#+***+****+#*+*+==+************#+#**##***####*#**######",
	"###############################++##++#*+*##*=******+++*++#+===****************###++*+*#####****#####",
	"############################+#*##++####++##+*****+-***+*++*==+************####+*####**#####*##**####",
	"########################*###*###**####**=+#*********++#++***=*********#*###+####*###**#####*##**####",
	"##########################*####**####**+#**+*****#*#+++++**********#*##**###########*######*###*####",
	"##############################*#####=++**#**+#***#+++*+*#*******#*##+###############*######*###**###",
	"#######################*######*####++*#*#*#******#**##++*#**########################*##########*####",
	"######################*############+*=+##**++****#*##*+**#######**########################*####*####",
	"##############################*####**+#*+++******##++########*+#####################################",
	"#####################*#############++*+**+#******#########+++###*###################################",
	"##############################*#++**#++++*++#**########+++########################*#################",
	"#########################*##*=+++#+++++++*+###########*#############################################",
	"######################*###*=+++#++++++++########*###################################################",
	"#########################=****+++++**#######*#######################################################",
	"###################*#*###+********###*##############################################################"
];

// Color zones sampled from the user-supplied reference image at the same 100 × 56 grid.
// D = dark gray, M = gray, r = dark red, R = red, H = highlight.
const ARSENAL_LOGO: readonly string[] = [
	":@@@                                                                                    *@@@@@",
	"    #@@@@@@@@                           @@@@@                                                                @@@",
	"    #@@    @@+  @@@@@*                  @@ @@:    @@ @@@@@    @@@@@@*    -@@@@@%   #@*@@@@@    @@@@@@@.      @@@",
	"    #@@   :@@      @@*                 @@+ #@@    @@@   @@#  @@@        @@%   %@@  #@@*  #@@        .@@      @@@",
	"    #@@@@@@@       @@*                -@@   @@#   @@*         @@@@@@    @@@@@@@@@  #@@   =@@    @@@@@@@      @@@",
	"    #@@            @@*                @@@@@@@@@   @@*             %@@   @@:        #@@   =@@  +@@    @@      @@@",
	"    #@@         @@@@@@@@-            %@@     @@@  @@*        @@@@@@@@    @@@@@@@=  #@@   =@@   @@@@@@@@   @@@@@@@@@",
];

const COLOR_MASK: readonly string[] = [
	"DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
	"DDDDDDDDDDDrDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDrrDDDDDDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDrDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDrrrrrDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDDRDDDDDDDDDDDDDDDDDDDDrMDDDDDMrDDrrrRRRRrrrDDDDrrrDrrrrMDDDDDDDDMDDDDDDDDDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDDDDrDrDDDDDDDDDrRRRRrDDDRDrrrRRrRRRRRRrrrrrrDMrRrrrrDrrMDDDDDDDDMDDDDDDDDDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDDDDDDDDDDDDDDDDrrRrrrrrrRrDMrrrrrrrrrrrrrrrMrrrMrrrMMrMMDDDDDMDDDDRrrDDDDDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDDDMDDRrDrMrRrMMRRRrRrrrrrrrMrrrrMDMrrrrrrMMMrrrMrDrrDrrMDDDrrrDDDDDDDDDDDDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDDDDDDDMrDMRRRrrrrrrrrrrrrrrrRRrrrrMMrrrrrrrrrrrrDDDDrMrDDMMDrDDDDDDDDDDDDDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDDDrDDDDDDMRrRrrrrrrrrrrrRRrrrrrrrrrrrrrrrrrrrrrrDrRrMDMDDMMMMMMMrrDDDDDDDDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDDDDDDDDRRRRRrrDRRrRRRrrrRrrrrRrrrrRrDrRrrrrrMrMRrrrrrDDDDrDMMrrMDDrrrDDDDDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDDDDMrrrRRrrrRrrDrrRrRRrRrrrrrrrrrrrrrrDDrrrrrrrrrrrMrDDrrrDDMMMMrMDDDDDrDDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDDMrDDMrrRrrrrMrMDRrRrrrrrrrrrrrrDrrrrrrDMrrrrrrRrrMDrrrrDDDDDDMMMMrDDDDDDDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDMMDMrRRrrrRRRrrMMRRRrrrrrrrrrRrrrrMDMrrrrMMRrrrrMDMrrrrDDRDMDDDMrrRrrDDDDDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDrDDMrrRrrrrrRrrrMDDMrMrrrrrrrrrrrrrrrMDMDrrMMMMMDrMrMMrDMDDrMDMMDMMrrRRDDDDDDDDDDDDDDDDD",
	"DDDDDDDDDDDMDDDRRRRrrRrRrrrrDDMMrrrMrrrrrrrDMrrMrMMDDDDrrDrrrMMMDDDDDDDrDMDrMMMrMrRMDMDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDDrDrrRrrRRRrrrrrDMMMDrrMDrMMMrMDrMMMMMMMMMDDMMMMDDDDDDDDDrMMMMDMMMMMMrRDDrDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDMrrRrrrDRrRrrrDrMMrRrMMMrDMrDMMMMDDDMMMDMrDrMDMDDDDDDDrDDrDMMMMDMMrMMMRDDDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDMMrrrrrDrRRRrrrrDMDDMMMMDrMMMMMMMMDDDDMMDDMDDrDDDDDDDrDDDRDrMMMMMMMMrMRDDDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDDDrRrrDDDMRrrrrrDMMMMMMMrrrrMrrrrMDMMMMDMDMMMDrDDDDDDrMDDrDrMMMMDMMMMMRDDDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDDDDrrrDDDrrrrrrrrMRrMrrRRRrrRrrrrRrMrMrMMDDMMMrDDDDDrrMDMrrrrMMMMDMMMMRDDDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDDDDrrrDDDDMMrMrrrrrrrrrrrrrrrRRMrrDrMRRrMMMMMrDDDDDDMrMDrrrDMMMMMMMMMMrMDDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDDDDDrMDDDMDDDMrrMRrMrRRRRRRRRRRRRrRMRRrMMrrrDDDDDDrDMrrDRrrDrMMMMMrDMMRDDDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDDDDDrrDDDDMMrrRrMMMrRRRRRRRRRRRRRRRrRRRRrrMDDDDDDDDDMrMMrrMDRrMMMrrDDDRDMDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDDDDDDrDDMrRrrrrrrrrRrrrrrrrrRRrrrrrrrrrrMDDDDDMDDDDMMMDRrrrDrRMMMMrDDMrDDDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDDDDDDDDDDDrrRRRRRRRRRRRRRRRRRRRRRRRRrDDDDMDRrrDDDDDrrrrRrrrDMRrMrrrrDMrDDrDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDDDDDDDDDDDDDMMMMMMMrMMMMMMMMMrMMMMMMDMMMDDDMDDDDDDDDMDMMMMMDMMMDMMMMDDDDDDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDDDDDDDDDDDDDMRRRRRRRRRRRRRRRRRRRRRrMMRRRMMMMrMMRDDDrrDRRrrrDrrRMrrrrrDDDDDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDDDDDDDDDDDDDDDMRrRRRRRrRRRRRRRRRMMMMrRRRMMMMDDrDDDDRDRRrMrrDMrrMMrrMRrDDDDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDDDDDDDDDDDDDDDDDMrRRrrrrrrrrRRMMMMMrrRRMMMMMMMMDDDDrRRrMrMrDMMMMMMMMMMDDDDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDDDDDDDDDDDDDDDDDMRRRRRRRRRrrMMMMMMrrRRRMMMMMMDDDDDDrRRrrrrrDMMrMMDMrMMrDDDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDDDDDDDDDDDDDrDDDDMRRrrrrrMMMMMMMrrrrrRrMMMMMMMDDDDMrRRMrMMMDMMMMMMMMMDMrDDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDDDDDDDDDDDDMMDDDDMRRRrMMRrDDDMrrrrRrRRrMDDDDDDDDDDDrRDrRrrMDMrMMMMMMMMDMDDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDMMMMrrRDDDDDDDDDDDDMDDrRDRrRMrMDMMMMMDDDMMDDMDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDMrrDDMDDDDDDDDDrMMMMrMMrRDRRRMMDDDMMMMMrDDMDDDDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDrDMDMMDDDDDDrMMDrMMMMMrDrDrDrrRMMDDDMMMMMMMDDDDDDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDMrrrDDDrrrrrMMMDMMMMMMrDDrDDDRrMMDDMMMMMDMDDDDDDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDDDDDDDrrDDDDDDDDDDDDDDDDDMRrrrMDrrrrrrDMMMrrMMMrRDDrDDDRRRMDDDMMrMMMMDDDDDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDDDDMrDDDDDDDDDDDDDDDDDDDDrrrDMrDrrrDDDDMMMDrrrrrrrDDDDDDRRDMDDMMMrMMMMDDDDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDDRDDDDDDDDDDDDDDDDDDDDDDrRrDrDrrrrrMDDDDrrrrDrrrrrDRrDDDDRRDDDDMMMMMDMMDDDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDrDDDDDDDDDDDDDDDDDDDDDDMRRRrrMMDrrrrrrrrMDrrDMMrDMrRrRDDDDrrRDDDMMMMDDDMMDDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDDDDDDDDDDDDMDDDDDDDDrRrRRrRrDrDrrrrrrrMMrDrMMrrRrrrrrrrMMrMDrDDDMMDDDDMMMDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDRRrRRrrRrDDrrrrrrrrrRMrrMRrrrrrrrMMMMMMDrDMRDMMMDDDDMDMMDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDDDDDDDDDDDDDDDDDMRrDrRDRRrDDRrrMMMMrrMrrDrrrrrrrrrMDDMDMMMMDDDrrMrMDDDDMMMMDDDDDDDDDDDD",
	"DDDDDDDDDDDDDDDDDDDDDDDDDDDRDMDDRDDDDRRDDrrrMMMMDMMrrRrrrrrrrMDMMMMDDDDDrrDDDDMDDDDDMDMMMDDDDDDDDDDD",
	"DDDDDDDDDDDDDDDDDDDDDDDrMDDrDDDrMDDDrMRrDrrMMDDDMMrrRrrrrrrrMMMMMDrDDDrDDDrDDDMDDDDDMDDMMDDDDDDDDDDD",
	"DDDDDDDDDDDDDDDDDDDDDDDDDrDDDDrrDDDMrrDMrrDDDDDDDrrRRrrrrrMMMMDrDDrrDDDDDDDDDDMDDDDDMDDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDDDDDDDDDDDDDDDDDrDDDDrrrrRDMMMrrrDMrrrRDrrrrrMDMDDrDDDDDDDDDDDDDDMDDDDDMDDDMDDDDDDDDDDD",
	"DDDDDDDDDDDDDDDDDDDDDDDMDDDDDMDDDrrrDRDDDrrrrMDMMDMMMDMrDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDDDDDDDDDDMDDDDDDDDDDrrMrDDrrrRrMMDMDDDMMDDDDDDDRDDDDDDDDDDDDDDDDDDDDDDMDDDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDDDDDDDDDDDDDDDDDMDDDMrrDrRRRrrrrrDDrMDDDDDDDRrDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDDDDDDDDDrDDDDDDDDDDDrrrrrMrDrrMMrDDDDDDDDrRRDDDMDDDDDDDDDDDDDDDMDDDDDDDDDDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDDDDDDDDDDDDDDDDDMDrrrMrrrrrrrMrDDDDDDDrRRDDDDDDDDDDDDDDDDDDDDDDrDDDDDDDDDDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDDDDDDDDDDDDrDDrrrrrrrRrrrrrrDDDDDDDDDrrDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDDDDDDDDDDMDDMrrrrMRRrrrrrDDDDDDDMDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDDDDDDDDDDDDrRrrrrrRRrrDDDDDDDMDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
	"DDDDDDDDDDDDDDDDDDDrDrDDMrMrrrrrMDDMDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD"
];

function paint(line: string, colors: string, theme: Theme): string {
	let result = "", buffer = "", current = "";
	const colorOf = (mark: string): "dim" | "muted" | "error" | "text" => mark === "R" ? "error" : mark === "r" ? "muted" : mark === "H" ? "text" : mark === "M" ? "muted" : "dim";
	const flush = () => { if (buffer) result += theme.fg(current as "dim" | "muted" | "error" | "text", buffer); buffer = ""; };
	for (let i = 0; i < line.length; i++) { const next = colorOf(colors[i] || "D"); if (next !== current) { flush(); current = next; } buffer += line[i]!; }
	flush(); return result;
}

function splash(theme: Theme, width: number): string[] {
	const label = `${theme.bold(theme.fg("error", "◆"))}${theme.fg("text", "  ID: 沫路")} ${theme.fg("dim", "// PI ARSENAL")}`;
	const artWidth = Math.max(...PORTRAIT.map(visibleWidth), visibleWidth(label));
	if (width < artWidth) return [truncateToWidth(label, width)];
	const center = (line: string) => " ".repeat(Math.max(0, Math.floor((width - artWidth) / 2))) + line;
	const logoWidth = Math.max(...ARSENAL_LOGO.map(visibleWidth));
	if (width < Math.max(artWidth, logoWidth)) return [truncateToWidth(label, width)];
	const centerLogo = (line: string) => " ".repeat(Math.max(0, Math.floor((width - logoWidth) / 2))) + theme.fg("error", line);
	return ["", ...PORTRAIT.map((line, index) => center(paint(line, COLOR_MASK[index] || "", theme))), "", ...ARSENAL_LOGO.map(centerLogo), center(label), ""];
}

export default function startupSplash(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setHeader((_tui, theme) => ({ invalidate() {}, render(width: number): string[] { return splash(theme, width); } }));
	});
}
