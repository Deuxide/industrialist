import math

def run_reverse_calculator():
    recipes = {}
    print("--- 🏗️ Factory Architect Mode ---")
    print("Step 1: Define your machine recipes.")
    
    while True:
        name = input("\nMachine Name (e.g., Assembler): ").lower()
        time = float(input(f"  Process Time (seconds): "))
        
        # Define Inputs
        inputs = {}
        print("  INPUTS (type 'qq' to finish)")
        while True:
            item = input("    Item Name: ").lower()
            if item == 'qq': break
            qty = float(input(f"    Qty of {item}: "))
            inputs[item] = qty / time # Store as units per second
            
        # Define Outputs
        outputs = {}
        print("  OUTPUTS (type 'qq' to finish)")
        while True:
            item = input("    Item Name: ").lower()
            if item == 'qq': break
            qty = float(input(f"    Qty of {item}: "))
            outputs[item] = qty / time # Store as units per second
            
        recipes[name] = {'inputs': inputs, 'outputs': outputs}
        
        if input("\nAdd another recipe? (y/n): ").lower() != 'y':
            break

    print("\n" + "="*40)
    print("Step 2: Set your Target Production")
    target_item = input("What is the FINAL item you want to produce? ").lower()
    target_qty = float(input(f"How many {target_item}s? "))
    target_time = float(input(f"In how many seconds? (e.g., 60 for per minute): "))
    
    required_rate = target_qty / target_time # Target units per second

    print("\n" + "="*40)
    print(f"🎯 TARGET: {required_rate:.2f} {target_item}/s")
    print("="*40)

    # Calculation Logic
    def find_producer(item):
        for m_name, data in recipes.items():
            if item in data['outputs']:
                return m_name, data['outputs'][item]
        return None, None

    # We use a simple queue to trace back the requirements
    requirements = {target_item: required_rate}
    final_bill = {}

    to_process = [target_item]
    while to_process:
        current_item = to_process.pop(0)
        needed_rate = requirements[current_item]
        
        machine, rate_per_machine = find_producer(current_item)
        
        if machine:
            # How many machines to meet the rate?
            count = math.ceil(needed_rate / rate_per_machine)
            final_bill[machine] = count
            
            # Now add this machine's inputs to the requirements
            for in_item, in_rate in recipes[machine]['inputs'].items():
                total_in_needed = in_rate * count
                requirements[in_item] = requirements.get(in_item, 0) + total_in_needed
                if in_item not in to_process:
                    to_process.append(in_item)

    print("SHOPPING LIST / MACHINE SETUP:")
    for m_name, count in final_bill.items():
        print(f" -> {count:>3}x {m_name.capitalize()}")
    
    print("\nTOTAL RAW MATERIAL DEMAND:")
    for item, rate in requirements.items():
        # If no machine produces it, it's a raw material
        if not find_producer(item)[0]:
            print(f" -> {item.capitalize()}: {rate:.2f}/s")

if __name__ == "__main__":
    run_reverse_calculator()