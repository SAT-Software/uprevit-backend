export const SYMBOLS_GRAPHICS_ENTITIES = [
	'Symbols',
	'Schematics',
	'Barcodes',
	'Other Components',
];
export type SymbolsGraphicsEntity = typeof SYMBOLS_GRAPHICS_ENTITIES[number];

export interface SymbolsGraphics {
    id?: string,
    image?: string,
    key?: string,
    text?: string,
    description?: string,
    text_present?: boolean,
    label_presence?: string[],
    entity?: SymbolsGraphicsEntity,
    count?: number,
    standard_symbol_id?: string,
    standard_ref_number?: string
}

export type BaseSymbolsGraphics<Action extends string, TData> = {
    id: string;
    action: Action;
    tab: 'symbols-graphics';
    data: TData;
}

export type StandardSymbolsGraphicsSelection = {
    id: string;
    text_present?: boolean;
    label_presence?: string[];
}

export type AddStandardSymbolsGraphicsData = {
    symbols: StandardSymbolsGraphicsSelection[];
}

export type AddSymbolsGraphics = BaseSymbolsGraphics<'add_symbols_graphics', SymbolsGraphics[]>;
export type UpdateSymbolsGraphics = BaseSymbolsGraphics<'update_symbols_graphics', SymbolsGraphics>;
export type DeleteSymbolsGraphics = BaseSymbolsGraphics<'delete_symbols_graphics', { id: string }>;
export type SymbolsGraphicsTabCompletion = BaseSymbolsGraphics<'update_symbols_graphics_tab_completion', { tab_completed: boolean }>;
export type AddStandardSymbolsGraphics = BaseSymbolsGraphics<'add_standard_symbols_graphics', AddStandardSymbolsGraphicsData>;
