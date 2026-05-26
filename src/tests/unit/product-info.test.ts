import { describe, expect, it } from '@jest/globals';
import { updateProductInformation } from '../../controllers/products/productData/product-info';
import { UpdateProductInformationData } from '../../types/products/product-info';

const baseProductInfoInput: UpdateProductInformationData = {
	product_name: 'Infusion Pump',
	product_plan_number: 'PLAN-001',
	product_description: 'Programmable infusion pump',
	target_date: null,
	actual_completion_date: null,
	market_geography: 'EU',
	country_of_origin: 'US',
	oem_contract_manufacturer: 'Acme Medical',
	commercial_clinical: 'Commercial',
	manufacturing_location: 'Boston',
};

describe('updateProductInformation', () => {
	it('does not require class of device or Basic UDI-DI fields', () => {
		const result = updateProductInformation(
			baseProductInfoInput,
			'product-information',
			'update_product_information',
		);

		expect(result.error).toBeNull();
		expect(result.updateQuery).toEqual({
			$set: expect.not.objectContaining({
				'product_information.data.class_of_device': expect.anything(),
				'product_information.data.basic_udi_di': expect.anything(),
			}),
		});
	});

	it('persists class of device and Basic UDI-DI when provided', () => {
		const result = updateProductInformation(
			{
				...baseProductInfoInput,
				class_of_device: 'EU MDR - Class IIa',
				basic_udi_di: 'BUDI-DI-123',
			},
			'product-information',
			'update_product_information',
		);

		expect(result.error).toBeNull();
		expect(result.updateQuery).toEqual({
			$set: expect.objectContaining({
				'product_information.data.class_of_device': 'EU MDR - Class IIa',
				'product_information.data.basic_udi_di': 'BUDI-DI-123',
			}),
		});
	});
});
